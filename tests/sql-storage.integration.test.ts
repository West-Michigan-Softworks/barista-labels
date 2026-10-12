import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sql from "mssql";
import { SqlStorage, sqlConfiguration } from "../server/sql-storage.js";
import { Storage, SqliteStorage } from "../server/storage.js";
import { readMigrationSource, migrateToSql } from "../server/migration.js";
import { createApp } from "../server/app.js";
import { newProject, zt411 } from "../shared/model.js";
import { zipSync, strToU8, unzipSync } from "fflate";

test(
  "SQL Server scripts, migration, revisions, assets, publishing and atomic queue contracts",
  {
    skip: !process.env.BARISTA_SQL_TEST_DATABASE,
    timeout: 180000,
  },
  async () => {
    const env: NodeJS.ProcessEnv = {};
    for (const suffix of [
      "SERVER",
      "DATABASE",
      "USER",
      "PASSWORD",
      "PORT",
      "ENCRYPT",
      "TRUST_SERVER_CERTIFICATE",
    ])
      env[`BARISTA_SQL_${suffix}`] = process.env[`BARISTA_SQL_TEST_${suffix}`];
    // Explicit opt-in and a disposable-name guard prevent use of a production DB.
    assert.match(env.BARISTA_SQL_DATABASE!, /^BaristaTest_[A-Za-z0-9_]+$/);
    const pool = await new sql.ConnectionPool(sqlConfiguration(env)).connect();
    const sourceDir = mkdtempSync(join(tmpdir(), "barista-sql-source-"));
    const localDir = mkdtempSync(join(tmpdir(), "barista-sql-runtime-"));
    let app: ReturnType<typeof createApp>["app"] | undefined;
    let target: SqlStorage | undefined;
    try {
      const existing = await pool
        .request()
        .query(
          "SELECT COUNT(*) AS count FROM sys.tables WHERE is_ms_shipped = 0",
        );
      assert.equal(
        existing.recordset[0].count,
        0,
        "Use a new empty disposable database for each integration run",
      );
      const install = async () => {
        for (const name of [
          "002-schema.sql",
          "003-procedures.sql",
          "004-permissions.sql",
        ]) {
          const script = readFileSync(join("sql", name), "utf8")
            .replace(/^:.*$/gm, "")
            .replaceAll("$(BaristaDatabase)", env.BARISTA_SQL_DATABASE!);
          for (const batch of script.split(/^GO\s*$/im))
            if (batch.trim()) await pool.request().batch(batch);
        }
      };
      await install();
      // Exercise procedure ownership chaining and the migration's IDENTITY_INSERT
      // under database users that have only the documented roles, not db_owner.
      await pool.request().batch(`
      CREATE USER [BaristaTestRuntime] WITHOUT LOGIN;
      ALTER ROLE barista_app ADD MEMBER [BaristaTestRuntime];
      CREATE USER [BaristaTestMigrator] WITHOUT LOGIN;
      ALTER ROLE barista_app ADD MEMBER [BaristaTestMigrator];
      ALTER ROLE barista_migration ADD MEMBER [BaristaTestMigrator];
      EXECUTE AS USER = 'BaristaTestRuntime';
      BEGIN TRANSACTION;
      EXEC barista.TransactionLock;
      EXEC barista.SchemaCheck;
      EXEC barista.RecordPut @Kind = N'role-test', @Id = N'test', @Value = N'{}';
      EXEC barista.RecordGet @Kind = N'role-test', @Id = N'test';
      EXEC barista.AssetPut @Id = N'test', @Bytes = 0x0001FF;
      EXEC barista.AssetGet @Id = N'test';
      EXEC barista.ProjectSave @Id = N'test', @Value = N'{"id":"test"}', @Expected = 0, @UpdatedAt = N'now';
      ROLLBACK TRANSACTION;
      REVERT;
      EXECUTE AS USER = 'BaristaTestMigrator';
      BEGIN TRANSACTION;
      EXEC barista.TransactionLock;
      EXEC barista.MigrationRecord @Kind = N'role-test', @Id = N'test', @Value = N'{}', @Sequence = 1;
      EXEC barista.MigrationRevision @ProjectId = N'test', @Revision = 1, @Value = N'{}';
      EXEC barista.MigrationSnapshot;
      ROLLBACK TRANSACTION;
      REVERT;
    `);
      const source = new Storage(new SqliteStorage(sourceDir));
      const project = newProject();
      project.name = "Migrated label";
      await source.saveProject(project, 0);
      await source.saveProject({ ...project, name: "Migrated revision" }, 1);
      await source.writeAsset("retained.btw", Buffer.from([0, 1, 128, 255]));
      await source.put("asset", "retained.btw", {
        id: "retained.btw",
        fileName: "retained.btw",
        name: "Original",
        kind: "original",
        mimeType: "application/octet-stream",
      });
      await source.put("job", "interrupted", {
        id: "interrupted",
        state: "sending",
        printer: { id: "p" },
        userId: "admin",
        createdAt: "now",
      });
      await source.close();
      const data = readMigrationSource(sourceDir);
      target = new SqlStorage(env);
      await migrateToSql(data, target, true);
      const execute = target.execute.bind(target);
      let writes = 0;
      target.execute = async (...args) => {
        if (args[0] === "MigrationRecord" && ++writes === 2)
          throw new Error("Injected migration failure");
        return execute(...args);
      };
      await assert.rejects(migrateToSql(data, target), /Injected/);
      target.execute = execute;
      await migrateToSql(data, target);
      // Repeat the full provisioning scripts with data present; verify no data loss.
      await install();
      await assert.rejects(migrateToSql(data, target), /empty/);
      const store = new Storage(target);
      let identity = { id: "admin", roles: ["Labels.Admin"] };
      const runtime = createApp({
        directory: localDir,
        storage: store,
        startQueue: false,
        authenticate: async () => identity,
      });
      app = runtime.app;
      await app.ready();
      await runtime.queue.stop();
      assert.equal(existsSync(join(localDir, "barista.sqlite")), false);
      assert.equal(existsSync(join(localDir, "assets")), false);
      assert.equal(
        (await store.get("job", "interrupted")).state,
        "outcome-unknown",
      );
      assert.equal((await store.revisions(project.id)).length, 2);
      assert.deepEqual(
        await store.readAsset("retained.btw"),
        Buffer.from([0, 1, 128, 255]),
      );
      const saved = await store.get("project", project.id);
      const concurrent = await Promise.allSettled([
        store.saveProject({ ...saved, name: "Winner" }, 2),
        store.saveProject({ ...saved, name: "Stale" }, 2),
      ]);
      assert.equal(
        concurrent.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal((await store.revisions(project.id)).length, 3);

      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6YxkAAAAASUVORK5CYII=",
        "base64",
      );
      const uploaded = await app.inject({
        method: "POST",
        url: "/api/assets",
        payload: {
          name: "pixel",
          kind: "image",
          mimeType: "image/png",
          base64: png.toString("base64"),
        },
      });
      assert.equal(uploaded.statusCode, 200, uploaded.body);
      const asset = uploaded.json();
      assert.deepEqual(
        (await app.inject(`/api/assets/${asset.id}`)).rawPayload,
        png,
      );
      assert.equal(
        (await app.inject(`/api/assets/${asset.id}/data`)).json().base64,
        png.toString("base64"),
      );
      const current = await store.get("project", project.id);
      current.assets = [asset];
      current.templates[0].elements = [
        {
          id: "image",
          type: "image",
          name: "pixel",
          assetId: asset.id,
          xUm: 0,
          yUm: 0,
          widthUm: 5000,
          heightUm: 5000,
          rotation: 0,
          locked: false,
        },
      ];
      const withAsset = await store.saveProject(current, current.revision);
      const exported = await app.inject(`/api/projects/${project.id}/export`);
      assert.equal(exported.statusCode, 200);
      assert.deepEqual(
        Buffer.from(unzipSync(exported.rawPayload)[`assets/${asset.id}`]),
        png,
      );
      const imported = await app.inject({
        method: "POST",
        url: "/api/projects/import",
        payload: { base64: exported.rawPayload.toString("base64") },
      });
      assert.equal(imported.statusCode, 200, imported.body);
      // Original imports need not be readable BTW envelopes to preserve their bytes.
      const original = await app.inject({
        method: "POST",
        url: "/api/import/btw",
        payload: {
          filename: "bad.btw",
          base64: Buffer.from("invalid envelope").toString("base64"),
        },
      });
      assert.equal(original.statusCode, 200);
      assert.deepEqual(
        await store.readAsset(original.json().originalAssetId),
        Buffer.from("invalid envelope"),
      );
      const fontFile =
        process.platform === "win32"
          ? "C:/Windows/Fonts/arial.ttf"
          : "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf";
      if (existsSync(fontFile)) {
        const font = readFileSync(fontFile);
        const uploadedFont = await app.inject({
          method: "POST",
          url: "/api/assets",
          payload: {
            name: "TestFont",
            kind: "font",
            mimeType: "font/ttf",
            base64: font.toString("base64"),
          },
        });
        assert.equal(uploadedFont.statusCode, 200, uploadedFont.body);
        assert.deepEqual(await store.readAsset(uploadedFont.json().id), font);
        withAsset.assets.push(uploadedFont.json());
        withAsset.templates[0].elements.push({
          id: "font-text",
          type: "text",
          name: "font",
          text: "Test",
          fontFamily: "TestFont",
          fontSizeUm: 3000,
          align: "left",
          bold: false,
          xUm: 10000,
          yUm: 0,
          widthUm: 30000,
          heightUm: 10000,
          rotation: 0,
          locked: false,
        });
      }
      const ready = await store.saveProject(withAsset, withAsset.revision);
      const published = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/labels/${project.templates[0].id}/publish`,
        payload: { revision: ready.revision },
      });
      assert.equal(published.statusCode, 200, published.body);
      const publication = published.json(),
        snapshot = (await store.get("publication", publication.id)).project;
      await store.saveProject(
        { ...ready, name: "Unpublished edits" },
        ready.revision,
      );
      assert.deepEqual(
        (await store.get("publication", publication.id)).project,
        snapshot,
      );
      await store.put("printer", "printer", {
        ...zt411,
        id: "printer",
        host: "127.0.0.1",
      });
      const prepared = await app.inject({
        method: "POST",
        url: "/api/printer/preparations",
        payload: {
          publicationId: publication.id,
          version: publication.version,
          printerId: "printer",
          location: null,
          quantity: 2,
        },
      });
      assert.equal(prepared.statusCode, 200, prepared.body);
      const previews = await app.inject(
        `/api/printer/preparations/${prepared.json().id}/previews`,
      );
      assert.ok(previews.json().previews[0].previewBase64);
      const request = {
        method: "POST" as const,
        url: "/api/printer/submissions",
        payload: {
          preparationId: prepared.json().id,
          idempotencyKey: "submit",
        },
      };
      const [first, retry] = await Promise.all([
        app.inject(request),
        app.inject(request),
      ]);
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().id, retry.json().id);
      assert.equal((await store.list("batch")).length, 1);
      const compilation = (await store.get("preparation", prepared.json().id))
        .compilationIds[0];
      const put = store.put.bind(store);
      let jobWrites = 0;
      store.put = async (kind, id, value) => {
        if (kind === "job" && ++jobWrites === 2)
          throw new Error("Injected batch failure");
        await put(kind, id, value);
      };
      const batch = await app.inject({
        method: "POST",
        url: "/api/batches",
        payload: {
          compilationIds: [compilation, compilation],
          idempotencyKey: "atomic",
        },
      });
      assert.equal(batch.statusCode, 500);
      store.put = put;
      assert.equal((await store.list("batch")).length, 1);
      const jobs = await store.list("job");
      assert.equal(jobs.length, 2); // migrated uncertain job and one static-label job
      assert.equal(
        (await store.nextQueuedJob("printer")).id,
        first.json().jobs[0].id,
      );
      assert.equal(
        (await store.jobSummaries()).every((job) => job.zpl === undefined),
        true,
      );
      identity = { id: "other", roles: ["Labels.User"] };
      assert.equal(
        (
          await app.inject(
            `/api/printer/preparations/${prepared.json().id}/previews`,
          )
        ).statusCode,
        403,
      );
      assert.equal((await app.inject("/api/jobs")).json().length, 0);
    } finally {
      await app?.close();
      if (!app) await target?.close();
      await pool.close();
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(localDir, { recursive: true, force: true });
    }
  },
);
