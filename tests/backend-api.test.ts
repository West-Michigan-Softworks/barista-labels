import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import net from "node:net";
import { createApp } from "../server/app.js";
import { newProject, zt411 } from "../shared/model.js";

test("persisted compilation sends once to local fake printer and detects changed profiles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barista-print-api-"));
  const chunks: Buffer[] = [];
  const printer = net.createServer((socket) =>
    socket.on("data", (chunk) => chunks.push(chunk)),
  );
  await new Promise<void>((resolve) => printer.listen(0, "127.0.0.1", resolve));
  const port = (printer.address() as net.AddressInfo).port;
  const { app, store } = createApp({
    directory,
    startQueue: false,
    authenticate: async () => ({ id: "operator", roles: ["Labels.Admin"] }),
  });
  try {
    const profile = { ...zt411, id: "test-printer", host: "127.0.0.1", port };
    store.put("printer", profile.id, profile);
    const project = newProject();
    const compilation = await app.inject({
      method: "POST",
      url: "/api/compile",
      payload: {
        project,
        templateId: project.templates[0].id,
        printerId: profile.id,
        quantity: 2,
      },
    });
    assert.equal(compilation.statusCode, 200);
    const c = compilation.json();
    project.name = "Changed after compilation";
    assert.notEqual(store.get("compilation", c.id).project.name, project.name);
    const payload = { compilationId: c.id, idempotencyKey: "same-request" };
    const first = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload,
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().quantity, 2);
    assert.equal(first.json().zpl, undefined);
    assert.equal(store.get("job", first.json().id).zpl, c.zpl);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload,
    });
    assert.equal(duplicate.json().id, first.json().id);
    assert.equal(store.list("job").length, 1);
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const job = store.get("job", first.json().id);
        if (job.state === "sent" && chunks.length) {
          clearInterval(timer);
          resolve();
        } else if (
          job.state === "failed" ||
          job.state === "outcome-unknown" ||
          Date.now() - started > 5000
        ) {
          clearInterval(timer);
          reject(
            new Error(`Fake printer delivery failed: ${JSON.stringify(job)}`),
          );
        }
      }, 10);
    });
    assert.equal(Buffer.concat(chunks).toString(), c.zpl);
    assert.ok(
      (await app.inject("/api/jobs"))
        .json()
        .every((job: any) => job.zpl === undefined),
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/jobs",
          payload: { compilationId: c.id, idempotencyKey: "x".repeat(201) },
        })
      ).statusCode,
      400,
    );
    const keyReuse = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { compilationId: "another", idempotencyKey: "same-request" },
    });
    assert.equal(keyReuse.statusCode, 409);
    store.put("printer", profile.id, { ...profile, offsetX: 1 });
    const changed = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { compilationId: c.id, idempotencyKey: "new-request" },
    });
    assert.equal(changed.statusCode, 409);
    assert.equal(store.list("job").length, 1);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => printer.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed HTTP body receives a client error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barista-body-"));
  const { app } = createApp({
    directory,
    startQueue: false,
    authenticate: async () => ({ id: "test", roles: ["Labels.Admin"] }),
  });
  try {
    for (const url of [
      "/api/projects",
      "/api/projects/import",
      "/api/import/btw",
      "/api/compile",
      "/api/render",
      "/api/jobs",
      "/api/assets",
    ]) {
      const reply = await app.inject({
        method: "POST",
        url,
        payload: "null",
        headers: { "content-type": "application/json" },
      });
      assert.equal(reply.statusCode, 400, url);
    }
    const corrupt = await app.inject({
      method: "POST",
      url: "/api/projects/import",
      payload: { base64: Buffer.from("not a zip").toString("base64") },
    });
    assert.equal(corrupt.statusCode, 400);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("API preserves projects and diagnostics in portable archives; rejects unsafe input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "barista-api-"));
  const { app } = createApp({
    directory: dir,
    startQueue: false,
    authenticate: async () => ({ id: "test", roles: ["Labels.Admin"] }),
  });
  try {
    const upload = await app.inject({
      method: "POST",
      url: "/api/assets",
      payload: {
        name: "Tiny PNG",
        mimeType: "image/png",
        kind: "image",
        base64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=",
      },
    });
    assert.equal(upload.statusCode, 200);
    const project = newProject();
    project.assets = [upload.json()];
    project.importDiagnostics = [
      { severity: "error", code: "fixture", message: "Unresolved source" },
    ];
    const saved = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: project,
    });
    assert.equal(saved.statusCode, 200);
    const archive = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/export`,
    });
    assert.equal(archive.statusCode, 200);
    const imported = await app.inject({
      method: "POST",
      url: "/api/projects/import",
      payload: { base64: archive.rawPayload.toString("base64") },
    });
    assert.equal(imported.statusCode, 200);
    assert.deepEqual(
      imported.json().importDiagnostics,
      project.importDiagnostics,
    );
    assert.notEqual(imported.json().id, project.id);
    assert.equal(
      (await app.inject(`/api/assets/${project.assets[0].id}/data`)).json()
        .base64,
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=",
    );
    const badBase64 = await app.inject({
      method: "POST",
      url: "/api/projects/import",
      payload: { base64: "not-a-base64-file" },
    });
    assert.equal(badBase64.statusCode, 400);
    const unsafe = zipSync({
      "../outside": strToU8("x"),
      "manifest.json": strToU8(JSON.stringify(project)),
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/projects/import",
      payload: { base64: Buffer.from(unsafe).toString("base64") },
    });
    assert.equal(rejected.statusCode, 400);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("API restricts administration and cancellation to owner or administrator", async () => {
  const dir = mkdtempSync(join(tmpdir(), "barista-role-"));
  const { app, store } = createApp({
    directory: dir,
    startQueue: false,
    authenticate: async () => ({ id: "operator", roles: ["Labels.User"] }),
  });
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/printers",
          payload: { ...zt411, host: "127.0.0.1" },
        })
      ).statusCode,
      403,
    );
    store.put("job", "other", {
      id: "other",
      state: "queued",
      userId: "someone-else",
      printer: { id: "p" },
    });
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/jobs/other/cancel" }))
        .statusCode,
      403,
    );
    assert.deepEqual((await app.inject("/api/me")).json(), {
      id: "operator",
      roles: ["Labels.User"],
    });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("API validates preview printer and records immutable compilation quantities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "barista-compile-"));
  const { app, store } = createApp({
    directory: dir,
    startQueue: false,
    authenticate: async () => ({ id: "test", roles: ["Labels.Admin"] }),
  });
  try {
    const project = newProject();
    const invalid = await app.inject({
      method: "POST",
      url: "/api/compile",
      payload: {
        project,
        templateId: project.templates[0].id,
        printer: { ...zt411, dotsPerMm: -1 },
      },
    });
    assert.equal(invalid.statusCode, 400);
    const badData = await app.inject({
      method: "POST",
      url: "/api/render",
      payload: {
        project,
        templateId: project.templates[0].id,
        printer: zt411,
        data: { item: 123 },
      },
    });
    assert.equal(badData.statusCode, 400);
    const badAssets = await app.inject({
      method: "POST",
      url: "/api/render",
      payload: {
        project: {
          ...project,
          assets: [
            {
              id: "fake",
              name: "Fake",
              fileName: "../outside",
              mimeType: "image/png",
              kind: "image",
            },
          ],
        },
        templateId: project.templates[0].id,
        printer: zt411,
      },
    });
    assert.equal(badAssets.statusCode, 400);
    const compiled = await app.inject({
      method: "POST",
      url: "/api/compile",
      payload: {
        project,
        templateId: project.templates[0].id,
        printer: zt411,
        quantity: 3,
      },
    });
    assert.equal(compiled.statusCode, 200);
    const result = compiled.json();
    assert.equal(result.quantity, 3);
    assert.match(result.zpl, /\^PQ3/);
    assert.equal(store.get("compilation", result.id).quantity, 3);
    const rendered = await app.inject({
      method: "POST",
      url: "/api/render",
      payload: { project, templateId: project.templates[0].id, printer: zt411 },
    });
    assert.equal(rendered.statusCode, 200);
    assert.ok(rendered.json().previewBase64);
    assert.equal(rendered.json().zpl, undefined);
    assert.equal(store.list("compilation").length, 1);
    const printerNotConfigured = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { compilationId: result.id, idempotencyKey: "x" },
    });
    assert.equal(printerNotConfigured.statusCode, 409);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
