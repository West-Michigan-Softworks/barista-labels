import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import net from "node:net";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { Store } from "./store.js";
import { authenticate, authConfiguration, requireAdmin, requireOwner } from "./auth.js";
import { registerPublishing } from "./publishing.js";
import { PrintQueue, type PrintJob } from "./queue.js";
import { compileProject, closeRenderer } from "./render.js";
import { projectSchema, printerSchema } from "../shared/model.js";
import { createPrinterCatalog, type PrinterCatalog } from "./sql-printers.js";

const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
function decodeBase64(value: unknown, max: number) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw fail("Invalid base64 content");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > max) throw fail("Content too large");
  return bytes;
}
const imageMimes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
]);
const fontMimes = new Set([
  "font/ttf",
  "font/otf",
  "font/woff",
  "font/woff2",
  "application/x-font-ttf",
  "application/x-font-opentype",
]);
function projectValid(project: any) {
  const parsed = projectSchema.safeParse(project);
  if (!parsed.success)
    throw fail(`Invalid project: ${parsed.error.issues[0]?.message}`);
  return {
    ...parsed.data,
    ...(typeof project.revision === "number"
      ? { revision: project.revision }
      : {}),
  };
}
function safeAsset(id: string) {
  if (!/^[a-zA-Z0-9_.-]{1,150}$/.test(id) || id.includes(".."))
    throw fail("Invalid asset identifier");
  return id;
}
function printerValid(printer: any) {
  const parsed = printerSchema.safeParse(printer);
  if (!parsed.success || !parsed.data.host)
    throw fail("Invalid printer profile or empty host");
  return parsed.data;
}
function dataValid(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail("Data must be named string fields");
  const entries = Object.entries(value);
  if (
    entries.length > 1000 ||
    entries.some(
      ([key, val]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        typeof val !== "string" ||
        val.length > 10000,
    )
  )
    throw fail("Invalid data fields or limits exceeded");
  return Object.fromEntries(entries);
}

export function createApp(
  options: {
    directory?: string;
    startQueue?: boolean;
    authenticate?: typeof authenticate;
    printerCatalog?: PrinterCatalog;
  } = {},
) {
  const directory = resolve(
    options.directory ?? process.env.BARISTA_DATA_DIR ?? "data",
  );
  const assetsDir = join(directory, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const store = new Store(directory);
  const catalog = options.printerCatalog ?? createPrinterCatalog();
  async function currentPrinter(id: string) {
    return id.startsWith("sql:")
      ? await catalog.resolve(id)
      : store.get("printer", id);
  }
  const queue = new PrintQueue(store, async (snapshot) => {
    const current = await currentPrinter(snapshot.id);
    if (
      !current ||
      JSON.stringify(printerSchema.parse(current)) !==
        JSON.stringify(printerSchema.parse(snapshot))
    )
      throw fail(
        "Printer configuration changed before transmission; compile again",
        409,
      );
  });
  const importTasks = new Set<Promise<unknown>>();
  for (const pending of store.list("import"))
    if (pending.status === "processing")
      store.put("import", pending.id, {
        ...pending,
        status: "failed",
        error:
          "Import interrupted by server restart; upload the retained original again.",
      });
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 32 * 1024 * 1024,
    trustProxy: false,
  });
  app.decorateRequest("identity", null);
  app.addHook("preHandler", async (request) => {
    const routePath = request.routeOptions.url ?? request.url.split("?")[0];
    if (
      routePath.startsWith("/api/") &&
      routePath !== "/api/config"
    )
      (request as any).identity = await (options.authenticate ?? authenticate)(
        request,
      );
    if (routePath.startsWith("/api/") && routePath !== "/api/config") {
      const identity = (request as any).identity;
      if (!identity.roles.some((role: string) => ["Labels.Admin", "Labels.User"].includes(role)))
        throw fail("Application role required", 403);
      const path = routePath;
      if (/^\/api\/(projects|assets|import)(\/|$)/.test(path) || ["/api/render", "/api/compile"].includes(path) ||
          (request.method === "POST" && ["/api/jobs", "/api/batches"].includes(path))) requireAdmin(identity);
      if (path.startsWith("/api/printers") && request.method !== "GET") requireAdmin(identity);
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const status = (error as any).statusCode ?? 500;
    reply.code(status).send({
      error:
        status >= 500
          ? ((error as any).publicMessage ?? "Server operation failed")
          : (error as Error).message,
    });
    request.log.error(error);
  });
  app.addHook("preHandler", async (request) => {
    if (
      request.url.startsWith("/api/") &&
      ["POST", "PUT"].includes(request.method) &&
      !/\/(cancel|check)(?:\?|$)/.test(request.url) &&
      (!request.body ||
        typeof request.body !== "object" ||
        Array.isArray(request.body))
    )
      throw fail("Request body must be a JSON object");
  });
  app.get("/api/config", async () => ({
    ...authConfiguration(),
    sqlPrintersEnabled: catalog.enabled,
  }));
  app.get("/api/me", async (request) => (request as any).identity);
  app.get("/api/projects", async () => store.list("project"));
  app.get("/api/projects/:id", async (request) => {
    const p = store.get("project", (request.params as any).id);
    if (!p) throw fail("Project not found", 404);
    return p;
  });
  app.post("/api/projects", async (request) => {
    const body = request.body as any;
    return store.saveProject(
      projectValid({ ...body, id: body.id ?? randomUUID() }),
      0,
    );
  });
  app.put("/api/projects/:id", async (request) => {
    const body = request.body as any;
    const id = (request.params as any).id;
    return store.saveProject(projectValid({ ...body, id }), body.revision);
  });
  app.delete("/api/projects/:id", async (request, reply) => {
    requireAdmin((request as any).identity);
    for (const publication of store.list("publication"))
      if (publication.projectId === (request.params as any).id)
        store.put("publication", publication.id, { ...publication, published: false });
    store.delete("project", (request.params as any).id);
    return reply.code(204).send();
  });
  app.get("/api/projects/:id/revisions", async (request) =>
    store.revisions((request.params as any).id),
  );
  app.get("/api/projects/:id/export", async (request, reply) => {
    const project = store.get("project", (request.params as any).id);
    if (!project) throw fail("Project not found", 404);
    const files: Record<string, Uint8Array> = {
      "manifest.json": strToU8(JSON.stringify(project)),
    };
    for (const asset of project.assets ?? []) {
      const id = safeAsset(asset.fileName);
      if (!existsSync(join(assetsDir, id))) throw fail(`Missing asset ${id}`);
      files[`assets/${id}`] = readFileSync(join(assetsDir, id));
    }
    return reply
      .type("application/zip")
      .header("Content-Disposition", 'attachment; filename="project.barista"')
      .send(Buffer.from(zipSync(files)));
  });
  app.post("/api/projects/import", async (request) => {
    const body = request.body as any;
    const bytes = decodeBase64(body.base64, 24 * 1024 * 1024);
    let declaredSize = 0,
      entryCount = 0;
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, {
        filter: (file) => {
          declaredSize += file.originalSize;
          entryCount++;
          if (
            file.name.includes("..") ||
            file.name.startsWith("/") ||
            file.name.includes("\\") ||
            file.name.includes(":")
          )
            throw fail("Unsafe archive path");
          if (
            file.originalSize > 32 * 1024 * 1024 ||
            declaredSize > 64 * 1024 * 1024 ||
            entryCount > 1000
          )
            throw fail("Archive entry limits exceeded");
          return true;
        },
      });
    } catch (error) {
      if ((error as any).statusCode) throw error;
      throw fail("Invalid or corrupt project archive");
    }
    let total = 0;
    for (const [name, content] of Object.entries(files)) {
      total += content.length;
      if (
        name.includes("..") ||
        name.startsWith("/") ||
        name.includes("\\") ||
        total > 64 * 1024 * 1024
      )
        throw fail("Unsafe archive");
    }
    if (!files["manifest.json"]) throw fail("Project manifest missing");
    let manifest: unknown;
    try {
      manifest = JSON.parse(strFromU8(files["manifest.json"]));
    } catch {
      throw fail("Invalid project manifest JSON");
    }
    const project = projectValid(manifest);
    project.id = randomUUID();
    delete project.revision;
    for (const asset of project.assets) {
      const fileName = safeAsset(asset.fileName);
      if (!files[`assets/${fileName}`])
        throw fail(`Missing bundled asset ${fileName}`);
      if (asset.kind === "font") {
        requireAdmin((request as any).identity);
        if (!fontMimes.has(asset.mimeType))
          throw fail("Unsupported font format");
      } else if (asset.kind === "original")
        asset.mimeType = "application/octet-stream";
      else if (!imageMimes.has(asset.mimeType))
        throw fail("Unsupported image format");
    }
    for (const [name, content] of Object.entries(files)) {
      if (name.startsWith("assets/")) {
        const id = safeAsset(name.slice(7));
        const existing = join(assetsDir, id);
        if (
          existsSync(existing) &&
          !readFileSync(existing).equals(Buffer.from(content))
        )
          throw fail(`Conflicting asset ${id}`);
        writeFileSync(existing, content);
      }
    }
    for (const asset of project.assets)
      store.put("asset", safeAsset(asset.id), asset);
    return store.saveProject(project, 0);
  });
  app.post("/api/import/btw", async (request) => {
    const body = request.body as any;
    const bytes = decodeBase64(body.base64, 24 * 1024 * 1024);
    const id = randomUUID();
    const originalAssetId = `${id}.btw`;
    const original = {
      id: originalAssetId,
      fileName: originalAssetId,
      name: body.filename ?? "Original BTW",
      mimeType: "application/octet-stream",
      kind: "original" as const,
    };
    writeFileSync(join(assetsDir, originalAssetId), bytes);
    store.put("asset", originalAssetId, original);
    store.put("import", id, { id, status: "processing", originalAssetId });
    const task = import("./btw.js")
      .then(async (module) => {
        const importer = (module as any).importBtw;
        const result = await importer(bytes, body.filename ?? "Imported label");
        if (result.project)
          result.project.assets = [...(result.project.assets ?? []), original];
        store.put("import", id, {
          id,
          status: "complete",
          ...result,
          originalAssetId,
        });
      })
      .catch((error) =>
        store.put("import", id, {
          id,
          status: "failed",
          error: String(error.message),
          originalAssetId,
        }),
      )
      .finally(() => importTasks.delete(task));
    importTasks.add(task);
    return { id, status: "processing", originalAssetId };
  });
  app.get("/api/import/:id", async (request) => {
    const result = store.get("import", (request.params as any).id);
    if (!result) throw fail("Import not found", 404);
    return result;
  });
  app.get("/api/assets/:id", async (request, reply) => {
    const id = safeAsset((request.params as any).id);
    const metadata = store.get("asset", id);
    const fileName = safeAsset(metadata?.fileName ?? id);
    if (!existsSync(join(assetsDir, fileName)))
      throw fail("Asset not found", 404);
    reply.header("X-Content-Type-Options", "nosniff");
    if (metadata?.kind === "original")
      reply.header("Content-Disposition", "attachment");
    return reply
      .type(metadata?.mimeType ?? "application/octet-stream")
      .send(readFileSync(join(assetsDir, fileName)));
  });
  app.get("/api/assets", async () => store.list("asset"));
  app.get("/api/assets/:id/data", async (request) => {
    const id = safeAsset((request.params as any).id);
    const metadata = store.get("asset", id);
    if (!metadata) throw fail("Asset not found", 404);
    return {
      ...metadata,
      base64: readFileSync(
        join(assetsDir, safeAsset(metadata.fileName)),
      ).toString("base64"),
    };
  });
  app.post("/api/assets", async (request) => {
    const body = request.body as any;
    const kind = body.kind ?? "image";
    const mimeType = body.mimeType ?? body.mime;
    if (kind === "font") requireAdmin((request as any).identity);
    if (
      typeof body.name !== "string" ||
      !["image", "font"].includes(kind) ||
      !(kind === "font" ? fontMimes : imageMimes).has(mimeType)
    )
      throw fail("Unsupported asset format");
    const data = decodeBase64(body.base64, 16 * 1024 * 1024);
    const id = createHash("sha256").update(data).digest("hex");
    const asset = {
      id,
      fileName: id,
      name: body.name,
      mimeType,
      kind,
      size: data.length,
    };
    writeFileSync(join(assetsDir, id), data);
    store.put("asset", id, asset);
    return asset;
  });
  app.get("/api/printers", async (request, reply) => {
    if (!catalog.enabled) return store.list("printer");
    const result = await catalog.list();
    reply.header(
      "X-Printer-Catalog-Warnings",
      String(result.diagnostics.length),
    );
    return result.printers;
  });
  app.get("/api/printers/diagnostics", async () =>
    catalog.enabled
      ? await catalog.list()
      : {
          printers: [],
          diagnostics: [],
          refreshedAt: new Date().toISOString(),
        },
  );
  app.post("/api/printers", async (request) => {
    requireAdmin((request as any).identity);
    const p = printerValid({ ...(request.body as any), id: randomUUID() });
    store.put("printer", p.id, p);
    return p;
  });
  app.put("/api/printers/:id", async (request) => {
    requireAdmin((request as any).identity);
    if ((request.params as any).id.startsWith("sql:"))
      throw fail("SQL catalog printers are read-only", 403);
    const p = printerValid({
      ...(request.body as any),
      id: (request.params as any).id,
    });
    store.put("printer", p.id, p);
    return p;
  });
  app.delete("/api/printers/:id", async (request, reply) => {
    requireAdmin((request as any).identity);
    if ((request.params as any).id.startsWith("sql:"))
      throw fail("SQL catalog printers are read-only", 403);
    store.delete("printer", (request.params as any).id);
    return reply.code(204).send();
  });
  app.post("/api/printers/:id/check", async (request) => {
    requireAdmin((request as any).identity);
    const printer = await currentPrinter((request.params as any).id);
    if (!printer) throw fail("Printer not found", 404);
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({
        host: printer.host,
        port: printer.port,
      });
      let settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        error ? reject(fail(error.message, 502)) : resolve();
      };
      socket.setTimeout(5000, () => done(new Error("Connection timed out")));
      socket.once("error", done);
      socket.once("connect", () => done());
    });
    return { connected: true, physicalStatus: "unknown" };
  });
  async function renderBody(body: any) {
    const project = projectValid(
      body.project ?? store.get("project", body.projectId),
    );
    const rawPrinter = body.printerId
      ? await currentPrinter(body.printerId)
      : body.printer?.id?.startsWith("sql:")
        ? await currentPrinter(body.printer.id)
        : body.printer;
    const parsedPrinter = printerSchema.safeParse(rawPrinter);
    if (!parsedPrinter.success) throw fail("Choose a valid printer profile");
    const printer = parsedPrinter.data;
    for (const asset of project.assets) {
      safeAsset(asset.id);
      safeAsset(asset.fileName);
      const registered = store.get("asset", asset.id);
      if (
        !registered ||
        registered.fileName !== asset.fileName ||
        registered.mimeType !== asset.mimeType ||
        registered.kind !== asset.kind
      )
        throw fail(`Unknown or modified asset metadata: ${asset.name}`);
    }
    const quantity = body.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000)
      throw fail("Quantity must be between 1 and 10000");
    const data = dataValid(body.data ?? {});
    const result = await compileProject(
      project,
      body.templateId,
      data,
      printer,
      assetsDir,
      { quantity },
    );
    return { result, project, printer, data, quantity };
  }
  app.post("/api/render", async (request) => {
    const { result } = await renderBody(request.body);
    return {
      widthDots: result.widthDots,
      heightDots: result.heightDots,
      previewBase64: result.previewBase64,
      diagnostics: result.diagnostics,
    };
  });
  app.post("/api/compile", async (request) => {
    const { result, project, printer, data, quantity } = await renderBody(
      request.body,
    );
    const id = randomUUID();
    const snapshot = {
      ...result,
      id,
      userId: (request as any).identity.id,
      project,
      printer,
      data,
      quantity,
      createdAt: new Date().toISOString(),
    };
    store.put("compilation", id, snapshot);
    return { ...result, id, quantity };
  });
  app.get("/api/compilations/:id/zpl", async (request, reply) => {
    const c = store.get("compilation", (request.params as any).id);
    if (!c) throw fail("Compilation not found", 404);
    requireOwner((request as any).identity, c);
    return reply
      .type("text/plain")
      .header("Content-Disposition", 'attachment; filename="label.zpl"')
      .send(c.zpl);
  });
  app.get("/api/jobs", async (request) => {
    const identity = (request as any).identity;
    return store.jobSummaries().filter(job => job.userId === identity.id || identity.roles.includes("Labels.Admin"));
  });
  async function printableCompilation(
    id: unknown,
    knownPrinters?: Map<string, any>,
  ) {
    if (typeof id !== "string" || !id)
      throw fail("Compilation identifier required");
    const c = store.get("compilation", id);
    if (!c) throw fail("Compilation not found", 404);
    if (
      !c.zpl ||
      c.diagnostics?.some((d: any) => d.severity === "error") ||
      c.project.importDiagnostics?.some((d: any) => d.severity === "error")
    )
      throw fail("Resolve compilation errors before printing");
    const configured = knownPrinters
      ? knownPrinters.get(c.printer.id)
      : await currentPrinter(c.printer.id);
    if (
      !configured ||
      JSON.stringify(printerSchema.parse(configured)) !==
        JSON.stringify(printerSchema.parse(c.printer))
    )
      throw fail("Printer configuration changed; compile again", 409);
    return c;
  }
  function newJob(
    c: any,
    userId: string,
    idempotencyKey: string,
    batchId?: string,
  ): PrintJob {
    return {
      id: randomUUID(),
      state: "queued",
      printer: c.printer,
      zpl: c.zpl,
      quantity: c.quantity,
      userId,
      compilationId: c.id,
      idempotencyKey,
      batchId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  function batchResponse(batch: any) {
    const jobs = batch.jobIds.map((id: string) => store.jobSummary(id));
    const counts: Record<string, number> = {};
    for (const job of jobs) counts[job.state] = (counts[job.state] ?? 0) + 1;
    return { id: batch.id, jobs, counts, createdAt: batch.createdAt };
  }
  app.post("/api/batches", async (request) => {
    const body = request.body as any;
    const identity = (request as any).identity;
    if (
      typeof body.idempotencyKey !== "string" ||
      !body.idempotencyKey ||
      body.idempotencyKey.length > 200
    )
      throw fail("Batch idempotency key required (maximum 200 characters)");
    if (
      !Array.isArray(body.compilationIds) ||
      body.compilationIds.length < 1 ||
      body.compilationIds.length > 5000 ||
      body.compilationIds.some((id: unknown) => typeof id !== "string" || !id)
    )
      throw fail(
        "Batch must contain between 1 and 5000 compilation identifiers",
      );
    const existing = store
      .list("batch")
      .find(
        (batch) =>
          batch.userId === identity.id &&
          batch.idempotencyKey === body.idempotencyKey,
      );
    if (existing) {
      if (
        JSON.stringify(existing.compilationIds) !==
        JSON.stringify(body.compilationIds)
      )
        throw fail(
          "Batch idempotency key already used for different compilations",
          409,
        );
      return batchResponse(existing);
    }
    const knownPrinters = new Map<string, any>();
    for (const compilationId of body.compilationIds) {
      const c = store.get("compilation", compilationId);
      if (c && !knownPrinters.has(c.printer.id))
        knownPrinters.set(c.printer.id, await currentPrinter(c.printer.id));
    }
    const compilations = await Promise.all(
      body.compilationIds.map((id: string) =>
        printableCompilation(id, knownPrinters),
      ),
    );
    const raced = store
      .list("batch")
      .find(
        (batch) =>
          batch.userId === identity.id &&
          batch.idempotencyKey === body.idempotencyKey,
      );
    if (raced) {
      if (
        JSON.stringify(raced.compilationIds) !==
        JSON.stringify(body.compilationIds)
      )
        throw fail(
          "Batch idempotency key already used for different compilations",
          409,
        );
      return batchResponse(raced);
    }
    const id = randomUUID();
    const jobs = compilations.map((c: any, index: number) =>
      newJob(c, identity.id, `${body.idempotencyKey}:${index}`, id),
    );
    const batch = {
      id,
      userId: identity.id,
      idempotencyKey: body.idempotencyKey,
      compilationIds: body.compilationIds,
      jobIds: jobs.map((job: PrintJob) => job.id),
      createdAt: new Date().toISOString(),
    };
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const job of jobs) store.put("job", job.id, job);
      store.put("batch", id, batch);
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    for (const printerId of new Set<string>(
      jobs.map((job: PrintJob) => job.printer.id),
    ))
      queue.kick(printerId);
    return batchResponse(batch);
  });
  app.get("/api/batches/:id", async (request) => {
    const batch = store.get("batch", (request.params as any).id);
    if (!batch) throw fail("Batch not found", 404);
    requireOwner((request as any).identity, batch);
    return batchResponse(batch);
  });
  app.post("/api/jobs", async (request) => {
    const body = request.body as any;
    const identity = (request as any).identity;
    if (
      typeof body.idempotencyKey !== "string" ||
      !body.idempotencyKey ||
      body.idempotencyKey.length > 200
    )
      throw fail("Idempotency key required (maximum 200 characters)");
    const existing = store
      .jobSummaries()
      .find(
        (j) =>
          j.idempotencyKey === body.idempotencyKey && j.userId === identity.id,
      );
    if (existing) {
      if (existing.compilationId !== body.compilationId)
        throw fail("Idempotency key already used for another compilation", 409);
      return existing;
    }
    const c = await printableCompilation(body.compilationId);
    const raced = store
      .jobSummaries()
      .find(
        (j) =>
          j.idempotencyKey === body.idempotencyKey && j.userId === identity.id,
      );
    if (raced) {
      if (raced.compilationId !== body.compilationId)
        throw fail("Idempotency key already used for another compilation", 409);
      return raced;
    }
    const job = newJob(c, identity.id, body.idempotencyKey);
    store.put("job", job.id, job);
    queue.kick(job.printer.id);
    return store.jobSummary(job.id);
  });
  app.post("/api/jobs/:id/cancel", async (request) => {
    const identity = (request as any).identity;
    const job = store.get<PrintJob>("job", (request.params as any).id);
    if (!job) throw fail("Job not found", 404);
    if (job.userId !== identity.id) requireAdmin(identity);
    queue.cancel(job.id);
    return store.jobSummary(job.id);
  });
  registerPublishing(app, { store, assetsDir, currentPrinter, queue, newJob, batchResponse, printableCompilation });
  const webRoot = resolve("dist");
  if (existsSync(join(webRoot, "index.html"))) {
    app.register(fastifyStatic, { root: webRoot, prefix: "/" });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Endpoint not found" })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("onClose", async () => {
    await queue.stop();
    await Promise.allSettled(importTasks);
    await closeRenderer();
    await catalog.close();
    store.close();
  });
  if (options.startQueue !== false) queue.start();
  return { app, store, queue, assetsDir };
}
