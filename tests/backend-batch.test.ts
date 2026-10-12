import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { newProject, zt411 } from "../shared/model.js";

test("batch validates all rows, rolls back failures, and reuses committed jobs on retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barista-batch-"));
  const { app, store, queue } = createApp({
    directory,
    startQueue: false,
    authenticate: async () => ({ id: "test", roles: ["Labels.Admin"] }),
  });
  // Deliberately stop transport; this test verifies durable atomic enqueue without any sockets.
  await queue.stop();
  try {
    const printer = { ...zt411, host: "127.0.0.1" };
    store.put("printer", printer.id, printer);
    for (const id of ["a", "b"])
      store.put("compilation", id, {
        id,
        printer,
        project: newProject(),
        zpl: `^XA^FD${id}^FS^PQ2^XZ`,
        quantity: 2,
        diagnostics: [],
      });
    store.put("compilation", "bad", {
      id: "bad",
      printer,
      project: newProject(),
      zpl: "",
      diagnostics: [{ severity: "error", message: "Invalid row" }],
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/batches",
      payload: { compilationIds: ["a", "bad"], idempotencyKey: "bad" },
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(store.list("job").length, 0);
    assert.equal(store.list("batch").length, 0);
    const originalPut = store.put.bind(store);
    let writes = 0;
    store.put = (kind, id, value) => {
      if (kind === "job" && ++writes === 2)
        throw new Error("Simulated storage failure");
      originalPut(kind, id, value);
    };
    const rolledBack = await app.inject({
      method: "POST",
      url: "/api/batches",
      payload: { compilationIds: ["a", "b"], idempotencyKey: "atomic" },
    });
    assert.equal(rolledBack.statusCode, 500);
    assert.equal(store.list("job").length, 0);
    assert.equal(store.list("batch").length, 0);
    store.put = originalPut;
    const payload = { compilationIds: ["a", "b"], idempotencyKey: "atomic" };
    const first = await app.inject({
      method: "POST",
      url: "/api/batches",
      payload,
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().jobs.length, 2);
    assert.deepEqual(first.json().counts, { queued: 2 });
    assert.deepEqual(
      first.json().jobs.map((job: any) => job.idempotencyKey),
      ["atomic:0", "atomic:1"],
    );
    assert.ok(
      first
        .json()
        .jobs.every(
          (job: any) => job.batchId === first.json().id && job.quantity === 2,
        ),
    );
    assert.ok(first.json().jobs.every((job: any) => job.zpl === undefined));
    assert.ok(store.list("job").every((job) => job.zpl.startsWith("^XA")));
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/batches",
      payload,
    });
    assert.equal(duplicate.json().id, first.json().id);
    assert.deepEqual(
      duplicate.json().jobs.map((job: any) => job.id),
      first.json().jobs.map((job: any) => job.id),
    );
    assert.equal(store.list("job").length, 2);
    const changed = await app.inject({
      method: "POST",
      url: "/api/batches",
      payload: { ...payload, compilationIds: ["b", "a"] },
    });
    assert.equal(changed.statusCode, 409);
    assert.equal(store.list("job").length, 2);
    assert.deepEqual(
      (await app.inject(`/api/batches/${first.json().id}`)).json().counts,
      { queued: 2 },
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
