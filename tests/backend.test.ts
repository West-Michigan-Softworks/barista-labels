import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { Store } from "../server/store.js";
import { PrintQueue, type PrintJob } from "../server/queue.js";

test("project revisions reject stale writers and preserve history", () => {
  const dir = mkdtempSync(join(tmpdir(), "barista-store-"));
  const store = new Store(dir);
  try {
    const first = store.saveProject({ id: "p", name: "First" }, 0);
    assert.equal(first.revision, 1);
    const second = store.saveProject({ id: "p", name: "Second" }, 1);
    assert.equal(second.revision, 2);
    assert.throws(
      () => store.saveProject({ id: "p", name: "Stale" }, 1),
      /conflict/,
    );
    assert.equal(store.get("project", "p").name, "Second");
    assert.equal(store.revisions("p").length, 2);
    store.delete("project", "p");
    const restored = store.saveProject({ id: "p", name: "Restored" }, 0);
    assert.equal(restored.revision, 3);
    assert.equal(store.revisions("p").length, 3);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("queue delivers bytes to local fake printer and recovers uncertain jobs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "barista-queue-"));
  const store = new Store(dir);
  const chunks: Buffer[] = [];
  const server = net.createServer((socket) =>
    socket.on("data", (chunk) => chunks.push(chunk)),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  const job: PrintJob = {
    id: "j",
    state: "queued",
    printer: { id: "p", host: "127.0.0.1", port: address.port },
    zpl: "^XA^FO10,10^FDTest^FS^XZ",
    userId: "u",
    compilationId: "c",
    idempotencyKey: "key",
    createdAt: "now",
    updatedAt: "now",
  };
  store.put("job", job.id, job);
  store.put("job", "interrupted", {
    ...job,
    id: "interrupted",
    state: "sending",
  });
  const queue = new PrintQueue(store);
  try {
    assert.equal(store.get("job", "interrupted").state, "outcome-unknown");
    queue.start();
    await new Promise<void>((resolve, reject) => {
      const began = Date.now();
      const timer = setInterval(() => {
        if (store.get("job", "j").state === "sent" && chunks.length) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - began > 5000) {
          clearInterval(timer);
          reject(
            new Error(
              "Queue test timed out: " +
                JSON.stringify(store.get("job", "j")) +
                " chunks=" +
                chunks.length,
            ),
          );
        }
      }, 10);
    });
    assert.equal(Buffer.concat(chunks).toString(), job.zpl);
    assert.throws(() => queue.cancel("j"), /queued/);
  } finally {
    queue.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("queued cancellation never sends bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "barista-cancel-"));
  const store = new Store(dir);
  store.put("job", "j", {
    id: "j",
    state: "queued",
    printer: { id: "p" },
    updatedAt: "",
  });
  const queue = new PrintQueue(store);
  try {
    assert.equal(queue.cancel("j").state, "cancelled");
  } finally {
    queue.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
