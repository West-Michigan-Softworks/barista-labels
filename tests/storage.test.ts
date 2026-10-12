import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  Storage,
  SqliteStorage,
  createStorage,
  type StorageBackend,
} from "../server/storage.js";
import { sqlConfiguration, SqlStorage } from "../server/sql-storage.js";
import {
  readMigrationSource,
  verifyMigration,
  migrateToSql,
  type MigrationData,
} from "../server/migration.js";
import { PrintQueue } from "../server/queue.js";
import { createApp } from "../server/app.js";

const env = {
  BARISTA_SQL_SERVER: "internal",
  BARISTA_SQL_USER: "service",
  BARISTA_SQL_PASSWORD: "secret",
};
test("backend selection validates settings and SQL mode never creates local storage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barista-select-"));
  try {
    assert.throws(
      () => createStorage(directory, { BARISTA_STORAGE_BACKEND: "invalid" }),
      /must be/,
    );
    assert.throws(
      () => createStorage(directory, { BARISTA_STORAGE_BACKEND: "sqlserver" }),
      /BARISTA_SQL_SERVER/,
    );
    assert.throws(
      () => sqlConfiguration({ ...env, BARISTA_SQL_PORT: "bad" }),
      /PORT/,
    );
    assert.throws(
      () => sqlConfiguration({ ...env, BARISTA_SQL_ENCRYPT: "yes" }),
      /boolean/,
    );
    const config = sqlConfiguration(env);
    assert.equal(config.database, "Barista");
    assert.equal(config.options?.encrypt, true);
    assert.equal(config.options?.trustServerCertificate, false);
    const storage = createStorage(directory, {
      ...env,
      BARISTA_STORAGE_BACKEND: "sqlserver",
    });
    assert.ok(storage.backend instanceof SqlStorage);
    assert.equal(existsSync(join(directory, "barista.sqlite")), false);
    assert.equal(existsSync(join(directory, "assets")), false);
    await storage.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("storage serializes concurrent revisions and reads and rolls back failed mutations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barista-async-"));
  const backend = new SqliteStorage(directory),
    store = new Storage(backend);
  try {
    await store.saveProject({ id: "p", name: "first" }, 0);
    const results = await Promise.allSettled([
      store.saveProject({ id: "p", name: "second" }, 1),
      store.saveProject({ id: "p", name: "stale" }, 1),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal((await store.revisions("p")).length, 2);
    await assert.rejects(store.saveProject({ id: "p" }, 2.5), {
      statusCode: 409,
    });
    let entered!: () => void, resume!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const mutation = store.transaction(async () => {
      await store.put("job", "partial", { state: "queued" });
      entered();
      await wait;
      throw new Error("rollback");
    });
    const failed = assert.rejects(mutation, /rollback/);
    await inside;
    let readFinished = false;
    const read = store.get("job", "partial").then((value) => {
      readFinished = true;
      return value;
    });
    await Promise.resolve();
    assert.equal(readFinished, false);
    resume();
    await failed;
    assert.equal(await read, undefined);
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("queue dispatch waits for commit, discards rolled-back kicks, and stops on failed durable claim", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barista-commit-"));
  const backend = new SqliteStorage(directory),
    store = new Storage(backend);
  let sends = 0;
  const queue = new PrintQueue(store, async () => {
    sends++;
    throw new Error("test transport blocked");
  });
  try {
    await assert.rejects(
      store.transaction(async () => {
        await store.put("job", "rollback", {
          id: "rollback",
          state: "queued",
          printer: { id: "p" },
        });
        queue.kick("p");
        await Promise.resolve();
        assert.equal(sends, 0);
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal(sends, 0);
    await store.put("job", "claim", {
      id: "claim",
      state: "queued",
      printer: { id: "p" },
    });
    const put = backend.put.bind(backend);
    backend.put = (kind, id, value: any) => {
      if (kind === "job" && value.state === "sending")
        throw new Error("Database offline");
      put(kind, id, value);
    };
    queue.kick("p");
    await queue.stop();
    assert.equal(sends, 0);
    assert.equal((await store.get("job", "claim")).state, "queued");
  } finally {
    await queue.stop();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rollback waits for in-flight asynchronous writes before releasing the transaction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barista-drain-"));
  const backend: StorageBackend = new SqliteStorage(directory);
  const put = backend.put.bind(backend);
  backend.put = async (kind, id, value) => {
    if (id === "fail") throw new Error("write failure");
    await new Promise((resolve) => setImmediate(resolve));
    await put(kind, id, value);
  };
  const store = new Storage(backend);
  try {
    await assert.rejects(
      store.transaction(async () => {
        await Promise.all([
          store.put("test", "fail", {}),
          store.put("test", "late", {}),
        ]);
      }),
      /write failure/,
    );
    assert.deepEqual(await store.list("test"), []);
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration validates source bytes and history without modifying SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barista-migration-"));
  const backend = new SqliteStorage(directory),
    store = new Storage(backend);
  const bytes = Buffer.from([0, 128, 255, 7]),
    id = createHash("sha256").update(bytes).digest("hex");
  try {
    const asset = {
      id,
      fileName: id,
      name: "binary",
      kind: "original",
      mimeType: "application/octet-stream",
      size: bytes.length,
    };
    await store.writeAsset(id, bytes);
    await store.put("asset", id, asset);
    await store.saveProject({ id: "p", name: "one", assets: [asset] }, 0);
    await store.saveProject({ id: "p", name: "two", assets: [asset] }, 1);
    await store.close();
    const before = readFileSync(join(directory, "barista.sqlite"));
    const data = readMigrationSource(directory);
    assert.equal(data.revisions.length, 2);
    assert.deepEqual(data.assets[0].Bytes, bytes);
    verifyMigration(data, structuredClone(data) as MigrationData); // structuredClone buffers become Uint8Arrays: hash accepts bytes.
    assert.deepEqual(readFileSync(join(directory, "barista.sqlite")), before);
    writeFileSync(join(directory, "assets", id), Buffer.from("damaged"));
    assert.throws(() => readMigrationSource(directory), /hash mismatch/);
    rmSync(join(directory, "assets", id));
    assert.throws(() => readMigrationSource(directory), /Missing source asset/);
    assert.throws(
      () => verifyMigration(data, { ...data, revisions: [] }),
      /verification/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration rejects populated targets and rolls back failed import or verification", async () => {
  const data: MigrationData = {
    records: [{ Kind: "project", Id: "p", Value: '{"id":"p"}', Sequence: 4 }],
    revisions: [],
    assets: [],
  };
  for (const scenario of [
    "populated",
    "write-failure",
    "verify-failure",
    "validate",
    "success",
  ]) {
    let rolledBack = false,
      committed = false,
      snapshots = 0,
      writes = 0;
    const target = {
      initialize: async () => {},
      begin: async () => {},
      rollback: async () => {
        rolledBack = true;
      },
      commit: async () => {
        committed = true;
      },
      execute: async (name: string) => {
        if (name === "MigrationSnapshot")
          return {
            recordsets: [
              scenario === "populated" ||
              (scenario === "success" && snapshots++ > 0)
                ? data.records
                : [],
              [],
              [],
            ],
          };
        writes++;
        if (scenario === "write-failure") throw new Error("failure");
      },
    } as unknown as SqlStorage;
    if (["validate", "success"].includes(scenario))
      await migrateToSql(data, target, scenario === "validate");
    else
      await assert.rejects(
        migrateToSql(data, target),
        /empty|failure|verification/,
      );
    assert.equal(committed, scenario === "success");
    assert.equal(rolledBack, scenario !== "success");
    if (scenario === "validate") assert.equal(writes, 0);
  }
});

test("SQL driver binds parameters, serializes requests, checks schema, and redacts errors", async () => {
  let active = 0,
    maximum = 0,
    error: any;
  const calls: { name: string; parameters: Record<string, unknown> }[] = [];
  const pool: any = {
    on() {},
    connect: async () => pool,
    close: async () => {},
    request() {
      const parameters: Record<string, unknown> = {};
      return {
        input(key: string, _type: unknown, value: unknown) {
          parameters[key] = value;
        },
        async execute(name: string) {
          active++;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setImmediate(resolve));
          active--;
          if (error) throw error;
          calls.push({ name, parameters });
          return {
            recordset: name.endsWith("SchemaCheck")
              ? [{ Version: 1, CompatibilityLevel: 130 }]
              : [],
          };
        },
      };
    },
  };
  const storage = new SqlStorage(env, () => pool);
  await storage.initialize();
  await Promise.all([
    storage.get("project", "quoted' id"),
    storage.list("project"),
  ]);
  assert.equal(maximum, 1);
  assert.equal(calls[1].parameters.Id, "quoted' id");
  assert.equal(calls[1].name, "barista.RecordGet");
  error = Object.assign(new Error("hidden secret server"), { number: 51001 });
  await assert.rejects(storage.get("project", "p"), { statusCode: 409 });
  error = new Error("hidden secret server");
  await assert.rejects(
    storage.list("project"),
    (error: any) =>
      error.statusCode === 503 && !/hidden|secret/.test(error.message),
  );
  await storage.close();
});

test("SQL startup failure rejects app readiness without creating a SQLite fallback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barista-unavailable-"));
  const pool: any = {
    on() {},
    connect: async () => {
      throw new Error("secret login");
    },
    close: async () => {},
  };
  const storage = new Storage(new SqlStorage(env, () => pool));
  const { app } = createApp({ directory, storage, startQueue: false });
  try {
    await assert.rejects(
      async () => {
        await app.ready();
      },
      (error: any) =>
        error.statusCode === 503 && !error.message.includes("secret"),
    );
    assert.equal(existsSync(join(directory, "barista.sqlite")), false);
    assert.equal(existsSync(join(directory, "assets")), false);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
