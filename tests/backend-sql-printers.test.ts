import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPrinterCatalog,
  PRINTER_CATALOG_QUERY,
} from "../server/sql-printers.js";
import { createApp } from "../server/app.js";
import { newProject } from "../shared/model.js";
import net from "node:net";
import { EventEmitter } from "node:events";
const row = (ip = "10.1.2.3") => ({
  printer_id: 7,
  name: "Receiving Zebra",
  location: 12,
  description: "Receiving station",
  brand: "Zebra",
  ip,
  date_added: new Date("2026-01-01T00:00:00Z"),
});
test("failed SQL pools are closed before reconnect and pool errors release prior instances", async () => {
  const instances: any[] = [];
  const catalog = createPrinterCatalog({
    enabled: true,
    env: { SQL_PRINTERS_USER: "test", SQL_PRINTERS_PASSWORD: "test" },
    poolFactory: () => {
      const instance = Object.assign(new EventEmitter(), {
        closed: 0,
        async connect() {
          if (instances.length === 1) throw new Error("Connection rejected");
          return instance;
        },
        async close() {
          instance.closed++;
        },
        request() {
          return {
            async query() {
              return { recordset: [row()] };
            },
          };
        },
      });
      instances.push(instance);
      return instance as any;
    },
  });
  try {
    await assert.rejects(
      catalog.list(),
      (error) => (error as any).statusCode === 503,
    );
    assert.equal(instances[0].closed, 1);
    await catalog.list(true);
    assert.equal(instances.length, 2);
    instances[1].emit("error", new Error("Pool failed"));
    await catalog.list(true);
    assert.equal(instances[1].closed, 1);
    assert.equal(instances.length, 3);
  } finally {
    await catalog.close();
  }
  assert.equal(instances[2].closed, 1);
});
test("SQL catalog maps stable IDs, reports invalid rows, and bypasses cache for print resolution", async () => {
  let rows: any[] = [
    row(),
    { ...row(), printer_id: 8, ip: "not an ip" },
    { ...row(), printer_id: 9, name: "" },
  ];
  let queries = 0;
  const catalog = createPrinterCatalog({
    enabled: true,
    query: async () => {
      queries++;
      return rows;
    },
    env: {},
    ttlMs: 60000,
  });
  try {
    assert.match(PRINTER_CATALOG_QUERY, /FROM dbo\.printersZPL/);
    assert.doesNotMatch(PRINTER_CATALOG_QUERY, /(INSERT|UPDATE|DELETE)/i);
    const first = await catalog.list();
    assert.equal(first.printers.length, 1);
    assert.equal(first.printers[0].id, "sql:7");
    assert.equal(first.printers[0].source, "sql");
    assert.equal(first.printers[0].location, 12);
    assert.equal(first.printers[0].dotsPerMm, 8);
    assert.equal(
      first.diagnostics.filter((d) => d.code === "INVALID_SQL_PRINTER").length,
      2,
    );
    assert.ok(
      first.diagnostics.some((d) => d.code === "UNVERIFIED_SQL_PROFILE"),
    );
    rows = [row("10.4.5.6")];
    assert.equal((await catalog.list()).printers[0].host, "10.1.2.3");
    assert.equal((await catalog.resolve("sql:7")).host, "10.4.5.6");
    assert.equal(queries, 2);
    rows = [];
    await assert.rejects(
      catalog.resolve("sql:7"),
      (error) => (error as any).statusCode === 409,
    );
  } finally {
    await catalog.close();
  }
});
test("SQL outages never expose credentials or use stale cached addresses", async () => {
  let fail = false;
  const catalog = createPrinterCatalog({
    enabled: true,
    query: async () => {
      if (fail) throw new Error("password=super-secret");
      return [row()];
    },
    env: {},
  });
  try {
    await catalog.list();
    fail = true;
    await assert.rejects(
      catalog.resolve("sql:7"),
      (error) =>
        (error as any).statusCode === 503 &&
        !String(error).includes("super-secret"),
    );
    await assert.rejects(
      catalog.list(),
      (error) => (error as any).statusCode === 503,
    );
  } finally {
    await catalog.close();
  }
});
test("API uses dynamic SQL printers, refuses SQL mutation, and blocks stale compilation endpoints", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barista-sql-"));
  let rows = [row()];
  let fail = false;
  const catalog = createPrinterCatalog({
    enabled: true,
    query: async () => {
      if (fail) throw new Error("private credential");
      return rows;
    },
    env: {},
    ttlMs: 0,
  });
  const { app, store, queue } = createApp({
    directory,
    startQueue: false,
    printerCatalog: catalog,
    authenticate: async () => ({ id: "test", roles: ["Labels.Admin"] }),
  });
  await queue.stop();
  try {
    const response = await app.inject("/api/printers");
    assert.equal(response.statusCode, 200);
    assert.equal(response.json()[0].host, "10.1.2.3");
    assert.equal(response.json()[0].source, "sql");
    const config = (await app.inject("/api/config")).body;
    assert.doesNotMatch(
      config,
      /private credential|SQL_PRINTERS_PASSWORD|SQL_PRINTERS_USER/,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/printers/sql:7",
          payload: { name: "Edited" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: "DELETE", url: "/api/printers/sql:7" }))
        .statusCode,
      403,
    );
    const profile = await catalog.resolve("sql:7");
    await store.put("compilation", "c", {
      id: "c",
      project: newProject(),
      printer: profile,
      zpl: "^XA^XZ",
      quantity: 1,
      diagnostics: [],
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { compilationId: "c", idempotencyKey: "original" },
    });
    assert.equal(accepted.statusCode, 200);
    rows = [row("10.4.5.6")];
    assert.equal(
      (await app.inject("/api/printers")).json()[0].host,
      "10.4.5.6",
    );
    const changed = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { compilationId: "c", idempotencyKey: "changed" },
    });
    assert.equal(changed.statusCode, 409);
    assert.equal((await store.list("job")).length, 1);
    fail = true;
    const outage = await app.inject("/api/printers");
    assert.equal(outage.statusCode, 503);
    assert.match(outage.json().error, /SQL printer catalog is unavailable/);
    assert.doesNotMatch(outage.body, /private credential/);
    const printOutage = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { compilationId: "c", idempotencyKey: "outage" },
    });
    assert.equal(printOutage.statusCode, 503);
    assert.equal((await store.list("job")).length, 1);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("queued SQL jobs revalidate changed or deleted endpoints and outages before any TCP connection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barista-sql-send-"));
  let rows = [row()];
  let unavailable = false;
  let connects = 0;
  const catalog = createPrinterCatalog({
    enabled: true,
    query: async () => {
      if (unavailable) throw new Error("hidden password");
      return rows;
    },
    env: {},
  });
  const { app, store, queue } = createApp({
    directory,
    startQueue: false,
    printerCatalog: catalog,
    authenticate: async () => ({ id: "test", roles: ["Labels.Admin"] }),
  });
  const originalConnection = net.createConnection;
  (net as any).createConnection = () => {
    connects++;
    throw new Error("Unexpected TCP connection");
  };
  try {
    const snapshot = await catalog.resolve("sql:7");
    for (const scenario of ["changed", "deleted", "outage"]) {
      rows =
        scenario === "changed"
          ? [row("10.4.5.6")]
          : scenario === "deleted"
            ? []
            : [row()];
      unavailable = scenario === "outage";
      await store.put("job", scenario, {
        id: scenario,
        state: "queued",
        printer: snapshot,
        zpl: "^XA^XZ",
        userId: "test",
        compilationId: "c",
        idempotencyKey: scenario,
        createdAt: "now",
        updatedAt: "now",
      });
      queue.kick(snapshot.id);
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(async () => {
          const job = await store.get("job", scenario);
          if (job.state === "failed") {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - started > 1000) {
            clearInterval(timer);
            reject(new Error("Queue validation did not fail"));
          }
        }, 10);
      });
      const failed = await store.get("job", scenario);
      assert.equal(failed.state, "failed");
      assert.doesNotMatch(failed.error, /Unexpected TCP|hidden password/);
    }
    assert.equal(connects, 0);
  } finally {
    (net as any).createConnection = originalConnection;
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
