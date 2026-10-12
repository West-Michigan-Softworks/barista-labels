import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { demoProject, newProject, zt411 } from "../shared/model";
import { csvHeaders, labelFields, parseLabelCsv } from "../shared/publishing";
import { workspaceMode } from "../shared/access";
test("workspace routing gives admins Editor by default and restricts users to Printer", () => {
  assert.equal(workspaceMode("/", true), "editor");
  assert.equal(workspaceMode("/printer", true), "printer");
  assert.equal(workspaceMode("/editor", false), "printer");
  assert.equal(workspaceMode("/", false), "printer");
});
test("CSV preserves values, quotes, multiline cells and BOM while counting only populated rows", () => {
  assert.equal(csvHeaders(["item", "description"]), "item,description\r\n");
  assert.deepEqual(
    parseLabelCsv(
      '\uFEFFdescription,item\r\n"Copper, fitting",0012\r\n,\r\n"Line one\nLine two",0013\r\n  ,  \r\n',
      ["item", "description"],
    ),
    [
      { description: "Copper, fitting", item: "0012" },
      { description: "Line one\nLine two", item: "0013" },
    ],
  );
  for (const csv of [
    "item,item\nx,y",
    "item\nx",
    "item,description,extra\nx,y,z",
    "item,description\nx",
    "item,description\nx,y,z",
    "item,description\nx,",
    'item,description\nx,"unclosed',
    "item,description\n,\n , ",
  ]) {
    assert.throws(() => parseLabelCsv(csv, ["item", "description"]));
  }
  assert.equal(
    parseLabelCsv("item\n" + "0001\n".repeat(5000), ["item"]).length,
    5000,
  );
  assert.throws(
    () => parseLabelCsv("item\n" + "0001\n".repeat(5001), ["item"]),
    /5000/,
  );
  assert.throws(
    () => parseLabelCsv("item\n" + "x".repeat(10001), ["item"]),
    /10000/,
  );
});
test("published fields follow declarations, excluding literal content and unused labels", () => {
  const project = demoProject();
  const template = project.templates[0];
  const text = template.elements.find(
    (e) => e.type === "text" && e.name === "Description",
  )!;
  template.elements = [
    {
      ...text,
      type: "text",
      text: "{{description}} {{description}}",
      dataMode: "template",
    } as any,
    {
      ...text,
      id: "literal",
      type: "text",
      text: "{{not_a_field}}",
      dataMode: "literal",
    } as any,
  ];
  assert.deepEqual(labelFields(project, template.id), ["description"]);
  (template.elements[0] as any).text =
    '=CONCATENATE(LEFT(item, 4), "{{ignored}}", {{description}})';
  (template.elements[0] as any).dataMode = "formula";
  assert.deepEqual(labelFields(project, template.id), ["description", "item"]);
  (template.elements[0] as any).text = "unknown";
  assert.throws(() => labelFields(project, template.id), /Undeclared field/);
});
test("API role matrix protects Editor and printer configuration with Admin and isolates resource ownership", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barista-permissions-"));
  let identity = { id: "user", roles: ["Labels.User"] };
  const { app, store, queue } = createApp({
    directory,
    startQueue: false,
    authenticate: async () => identity,
  });
  await queue.stop();
  try {
    for (const url of [
      "/api/projects",
      "/api/projects/missing",
      "/api/projects/missing/revisions",
      "/api/projects/missing/export",
      "/api/assets",
      "/api/assets/a/data",
      "/api/import/a",
      "/api/publications",
    ]) {
      assert.equal((await app.inject(url)).statusCode, 403, url);
    }
    for (const url of [
      "/api/projects",
      "/api/projects/import",
      "/api/assets",
      "/api/import/btw",
      "/api/render",
      "/api/compile",
      "/api/jobs",
      "/api/batches",
      "/api/printers",
    ]) {
      assert.equal(
        (await app.inject({ method: "POST", url, payload: {} })).statusCode,
        403,
        url,
      );
    }
    identity = { id: "admin", roles: ["Labels.Admin"] };
    const created = await app.inject({
      method: "POST",
      url: "/api/printers",
      payload: { ...zt411, location: 12, host: "127.0.0.1" },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().location, 12);
    assert.equal((await app.inject("/api/projects")).statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/api/printers/${created.json().id}`,
          payload: { ...created.json<any>(), name: "Updated" },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/printers/${created.json().id}`,
        })
      ).statusCode,
      204,
    );
    identity = { id: "user", roles: ["Labels.User"] };
    await store.put("compilation", "other", { userId: "another" });
    await store.put("batch", "other", { userId: "another" });
    await store.put("preparation", "other", { userId: "another" });
    assert.equal(
      (await app.inject("/api/compilations/other/zpl")).statusCode,
      403,
    );
    assert.equal((await app.inject("/api/batches/other")).statusCode, 403);
    assert.equal(
      (await app.inject("/api/printer/preparations/other/previews")).statusCode,
      403,
    );
    identity = { id: "unassigned", roles: [] };
    assert.equal((await app.inject("/api/me")).statusCode, 403);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("published CSV preparation queues exact snapshots atomically and isolates users and drafts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barista-publication-"));
  let identity = { id: "admin", roles: ["Labels.Admin"] };
  const runtime = createApp({
    directory,
    startQueue: false,
    authenticate: async () => identity,
  });
  const { app, store, queue } = runtime;
  await queue.stop();
  try {
    const project = demoProject();
    project.templates[0].elements = project.templates[0].elements.filter(
      (e) => e.name === "Description",
    );
    let saved = await store.saveProject(project, 0);
    const publish = async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/labels/${project.templates[0].id}/publish`,
        payload: { revision: saved.revision },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    assert.deepEqual((await app.inject("/api/published-labels")).json(), []);
    const label = await publish();
    assert.deepEqual(label.fields, ["description"]);
    assert.equal(
      (await app.inject(`/api/published-labels/${label.id}/csv`)).body,
      "description\r\n",
    );
    const snapshot = (await store.get("publication", label.id)).project;
    saved = await store.saveProject(
      { ...project, name: "Edited draft" },
      saved.revision,
    );
    assert.deepEqual(
      (await store.get("publication", label.id)).project,
      snapshot,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${project.id}/labels/${project.templates[0].id}/publish`,
          payload: { revision: 1 },
        })
      ).statusCode,
      409,
    );
    const printer = { ...zt411, id: "p", host: "127.0.0.1", location: 12 };
    await store.put("printer", printer.id, printer);
    identity = { id: "operator", roles: ["Labels.User"] };
    const body = {
      publicationId: label.id,
      version: label.version,
      printerId: printer.id,
      location: 12,
      csv: "description\nAlpha\n\nBeta\n  \n",
    };
    const prepare = (payload: any) =>
      app.inject({ method: "POST", url: "/api/printer/preparations", payload });
    for (const extra of [
      { quantity: 2 },
      { project },
      { printer },
      { compilationIds: ["a"] },
    ])
      assert.equal((await prepare({ ...body, ...extra })).statusCode, 400);
    assert.equal((await prepare({ ...body, location: 99 })).statusCode, 409);
    const prepared = await prepare(body);
    assert.equal(prepared.statusCode, 200, prepared.body);
    const preparation = prepared.json();
    assert.equal(preparation.count, 2);
    const persisted = await store.get("preparation", preparation.id);
    assert.equal(persisted.compilationIds.length, 2);
    const preview = (
      await app.inject(
        `/api/printer/preparations/${preparation.id}/previews?offset=1&limit=1`,
      )
    ).json();
    assert.equal(preview.previews[0].row, 2);
    assert.equal(
      preview.previews[0].previewBase64,
      (await store.get("compilation", persisted.compilationIds[1]))
        .previewBase64,
    );
    assert.equal(
      (
        await app.inject(
          `/api/printer/preparations/${preparation.id}/previews?offset=-1`,
        )
      ).statusCode,
      400,
    );
    const submitBody = {
      preparationId: preparation.id,
      idempotencyKey: "csv-print",
    };
    const submit = (payload = submitBody) =>
      app.inject({ method: "POST", url: "/api/printer/submissions", payload });
    const put = store.put.bind(store);
    let writes = 0;
    store.put = async (kind, id, value) => {
      if (kind === "job" && ++writes === 2) throw new Error("Storage failure");
      await put(kind, id, value);
    };
    assert.equal((await submit()).statusCode, 500);
    assert.equal((await store.list("job")).length, 0);
    assert.equal((await store.list("batch")).length, 0);
    store.put = put;
    const [first, retry] = await Promise.all([submit(), submit()]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(retry.json().id, first.json().id);
    assert.equal((await store.list("job")).length, 2);
    for (const [index, job] of first.json().jobs.entries()) {
      const compilation = await store.get(
        "compilation",
        persisted.compilationIds[index],
      );
      assert.equal(compilation.quantity, 1);
      assert.equal(job.quantity, 1);
      assert.equal((await store.get("job", job.id)).zpl, compilation.zpl);
    }
    const originalJob = await store.get("job", first.json().jobs[0].id);
    const reprint = () =>
      app.inject({
        method: "POST",
        url: `/api/printer/jobs/${originalJob.id}/reprint`,
        payload: { idempotencyKey: "explicit-reprint" },
      });
    assert.equal(
      (await reprint()).statusCode,
      409,
      "queued originals cannot be reprinted",
    );
    await store.put("job", originalJob.id, { ...originalJob, state: "sent" });
    const reprinted = await reprint();
    assert.equal(reprinted.statusCode, 200, reprinted.body);
    assert.equal((await reprint()).json().id, reprinted.json().id);
    assert.equal(
      (await store.get("job", reprinted.json().id)).zpl,
      originalJob.zpl,
    );
    assert.equal((await store.list("job")).length, 3);
    identity = { id: "other", roles: ["Labels.User"] };
    assert.equal((await submit()).statusCode, 403);
    assert.equal(
      (await app.inject(`/api/batches/${first.json().id}`)).statusCode,
      403,
    );
    assert.equal((await app.inject("/api/jobs")).json().length, 0);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/printer/jobs/${first.json().jobs[0].id}/reprint`,
          payload: { idempotencyKey: "steal" },
        })
      ).statusCode,
      403,
    );
    identity = { id: "operator", roles: ["Labels.User"] };
    const before = (await store.list("compilation")).length;
    const invalid = await prepare({
      ...body,
      csv: "description\nGood\n" + "X".repeat(1000),
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal((await store.list("compilation")).length, before);
    assert.equal((await store.list("job")).length, 3);
    await store.put("printer", printer.id, { ...printer, location: 13 });
    assert.equal(
      (await submit({ ...submitBody, idempotencyKey: "changed-printer" }))
        .statusCode,
      409,
    );
    await store.put("printer", printer.id, printer);
    identity = { id: "admin", roles: ["Labels.Admin"] };
    const republished = await publish();
    assert.equal(republished.id, label.id);
    assert.equal(republished.version, 2);
    identity = { id: "operator", roles: ["Labels.User"] };
    assert.equal(
      (await submit({ ...submitBody, idempotencyKey: "old-version" }))
        .statusCode,
      409,
    );
    // A committed retry remains a status read, even after the publication changes.
    assert.equal((await submit()).json().id, first.json().id);
    identity = { id: "admin", roles: ["Labels.Admin"] };
    const current = await prepare({ ...body, version: 2 });
    assert.equal(current.statusCode, 200, current.body);
    await app.inject({
      method: "POST",
      url: `/api/publications/${label.id}/unpublish`,
      payload: {},
    });
    assert.equal(
      (
        await submit({
          preparationId: current.json().id,
          idempotencyKey: "withdrawn",
        })
      ).statusCode,
      409,
    );
    assert.equal((await app.inject("/api/published-labels")).json().length, 0);
    await publish();
    await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    assert.equal((await store.get("publication", label.id)).published, false);
    assert.ok(
      (await store.get("publication-version", `${label.id}:1`)).project,
    );
    assert.equal((await store.list("job")).length, 3);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("static labels, publication validation and persistence retain assets independently of drafts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barista-static-publication-"));
  let runtime = createApp({
    directory,
    startQueue: false,
    authenticate: async () => ({ id: "admin", roles: ["Labels.Admin"] }),
  });
  await runtime.queue.stop();
  try {
    const { app, store, assetsDir } = runtime;
    const project = newProject();
    let saved = await store.saveProject(project, 0);
    const url = `/api/projects/${project.id}/labels/${project.templates[0].id}/publish`;
    const publish = () =>
      app.inject({
        method: "POST",
        url,
        payload: { revision: saved.revision },
      });
    const label = (await publish()).json();
    assert.deepEqual(label.fields, []);
    assert.equal(
      (await app.inject(`/api/published-labels/${label.id}/csv`)).statusCode,
      400,
    );
    await store.put("printer", "p", { ...zt411, id: "p", host: "127.0.0.1" });
    const body = {
      publicationId: label.id,
      version: label.version,
      printerId: "p",
      location: null,
    };
    for (const quantity of [0, 10001, 1.5])
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/printer/preparations",
            payload: { ...body, quantity },
          })
        ).statusCode,
        400,
      );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/printer/preparations",
          payload: { ...body, csv: "anything" },
        })
      ).statusCode,
      400,
    );
    const prepared = await app.inject({
      method: "POST",
      url: "/api/printer/preparations",
      payload: { ...body, quantity: 3 },
    });
    assert.equal(prepared.statusCode, 200, prepared.body);
    assert.equal(prepared.json().count, 3);
    const compilationId = (await store.get("preparation", prepared.json().id))
      .compilationIds[0];
    assert.equal((await store.get("compilation", compilationId)).quantity, 3);
    project.importDiagnostics = [
      { severity: "error", code: "IMPORT", message: "Unresolved" },
    ];
    saved = await store.saveProject(project, saved.revision);
    assert.equal((await publish()).statusCode, 400);
    project.importDiagnostics = [];
    project.templates[0].elements = [
      {
        id: "image",
        name: "Image",
        type: "image",
        assetId: "img",
        xUm: 0,
        yUm: 0,
        widthUm: 1000,
        heightUm: 1000,
        rotation: 0,
        locked: false,
      },
    ];
    saved = await store.saveProject(project, saved.revision);
    assert.equal((await publish()).statusCode, 400);
    const asset = {
      id: "img",
      name: "Image",
      fileName: "img",
      mimeType: "image/png",
      kind: "image" as const,
    };
    project.assets = [asset];
    await store.put("asset", asset.id, asset);
    saved = await store.saveProject(project, saved.revision);
    assert.equal((await publish()).statusCode, 400);
    writeFileSync(
      join(assetsDir, "img"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6YxkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    assert.equal((await publish()).statusCode, 200);
    saved = await store.saveProject(
      {
        ...project,
        assets: [],
        templates: [{ ...project.templates[0], elements: [] }],
      },
      saved.revision,
    );
    assert.equal(
      (await store.get("publication", label.id)).project.assets[0].id,
      "img",
    );
    await app.close();
    runtime = createApp({
      directory,
      startQueue: false,
      authenticate: async () => ({ id: "user", roles: ["Labels.User"] }),
    });
    await runtime.queue.stop();
    assert.equal(
      (await runtime.app.inject("/api/published-labels")).json()[0].id,
      label.id,
    );
    assert.equal(
      (await runtime.store.get("publication", label.id)).project.assets[0].id,
      "img",
    );
    assert.equal(
      (
        await runtime.app.inject(
          `/api/printer/preparations/${prepared.json().id}/previews`,
        )
      ).statusCode,
      403,
    );
  } finally {
    await runtime.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
