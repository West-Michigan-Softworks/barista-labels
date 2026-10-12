import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import type { PrintQueue, PrintJob } from "./queue.js";
import { requireAdmin, requireOwner, type Identity } from "./auth.js";
import { compileProject } from "./render.js";
import { csvHeaders, labelFields, labelSources, parseLabelCsv, type Publication } from "../shared/publishing.js";
import type { Project, PrinterProfile } from "../shared/model.js";

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const metadata = ({ project, ...label }: Publication) => label;
const identityOf = (request: any): Identity => request.identity;
const prepareSchema = z.object({
  publicationId: z.string().min(1), version: z.number().int().positive(),
  printerId: z.string().min(1), csv: z.string().max(16 * 1024 * 1024).optional(),
  location: z.number().int().nullable(),
  quantity: z.number().int().min(1).max(10000).optional(),
}).strict();
const submitSchema = z.object({ preparationId: z.string().min(1), idempotencyKey: z.string().min(1).max(200) }).strict();
interface Preparation {
  id: string; userId: string; publicationId: string; version: number;
  compilationIds: string[]; count: number; createdAt: string;
}

export function registerPublishing(app: FastifyInstance, context: {
  store: Store; assetsDir: string; queue: PrintQueue;
  currentPrinter: (id: string) => Promise<PrinterProfile | undefined>;
  newJob: (c: any, userId: string, key: string, batchId?: string) => PrintJob;
  batchResponse: (batch: any) => any;
  printableCompilation: (id: unknown, printers?: Map<string, any>) => Promise<any>;
}) {
  const { store, assetsDir, currentPrinter, queue, newJob, batchResponse, printableCompilation } = context;
  const currentPublication = (id: string, version?: number): Publication => {
    const publication = store.get<Publication>("publication", id);
    if (!publication?.published) throw fail("Label is no longer published; refresh the catalog", 409);
    if (version !== undefined && publication.version !== version) throw fail("Published label changed; refresh and prepare again", 409);
    return publication;
  };
  const ownedPreparation = (request: any, id: string) => {
    const preparation = store.get<Preparation>("preparation", id);
    if (!preparation) throw fail("Preparation not found", 404);
    requireOwner(identityOf(request), preparation);
    return preparation;
  };
  app.get("/api/publications", async request => {
    requireAdmin(identityOf(request));
    return store.list<Publication>("publication").map(metadata);
  });
  app.post("/api/projects/:id/labels/:templateId/publish", async request => {
    requireAdmin(identityOf(request));
    const params = request.params as { id: string; templateId: string };
    const body = z.object({ revision: z.number().int().positive() }).strict().safeParse(request.body);
    if (!body.success) throw fail("Expected saved project revision required");
    const project = store.get<Project & { revision: number }>("project", params.id);
    if (!project) throw fail("Project not found", 404);
    if (project.revision !== body.data.revision) throw fail("Project revision conflict", 409);
    if (project.importDiagnostics.some(d => d.severity === "error")) throw fail("Resolve import errors before publishing");
    let fields: string[];
    try { fields = labelFields(project, params.templateId); } catch (error) { throw fail((error as Error).message); }
    const template = project.templates.find(t => t.id === params.templateId)!;
    const imageIds = new Set(template.elements.filter(e => e.type === "image").map(e => e.assetId));
    const fonts = new Set(template.elements.filter(e => e.type === "text").map(e => e.fontFamily));
    for (const id of imageIds) if (!project.assets.some(a => a.id === id)) throw fail(`Missing image asset: ${id}`);
    const assets = project.assets.filter(a => imageIds.has(a.id) || (a.kind === "font" && fonts.has(a.name)));
    for (const asset of assets) {
      const registered = store.get("asset", asset.id);
      if (!/^[a-zA-Z0-9_.-]{1,150}$/.test(asset.fileName) || asset.fileName.includes("..") ||
          !registered || registered.fileName !== asset.fileName || registered.mimeType !== asset.mimeType || registered.kind !== asset.kind ||
          !existsSync(join(assetsDir, asset.fileName))) throw fail(`Missing or modified asset: ${asset.name}`);
    }
    const existing = store.list<Publication>("publication").find(p => p.projectId === project.id && p.templateId === template.id);
    const publication: Publication = {
      id: existing?.id ?? randomUUID(), name: template.name, projectName: project.name,
      projectId: project.id, templateId: template.id, sourceRevision: project.revision,
      version: (existing?.version ?? 0) + 1, published: true,
      publishedAt: new Date().toISOString(), publishedBy: identityOf(request).id, fields,
      project: { ...project, templates: [template], variables: labelSources(project, template.id), assets },
    };
    // Keep each published version available independently of subsequent drafts.
    store.db.exec("BEGIN IMMEDIATE");
    try {
      store.put("publication-version", `${publication.id}:${publication.version}`, publication);
      store.put("publication", publication.id, publication);
      store.db.exec("COMMIT");
    } catch (error) { store.db.exec("ROLLBACK"); throw error; }
    return metadata(publication);
  });
  app.post("/api/publications/:id/unpublish", async request => {
    requireAdmin(identityOf(request));
    const publication = store.get<Publication>("publication", (request.params as any).id);
    if (!publication) throw fail("Publication not found", 404);
    publication.published = false;
    store.put("publication", publication.id, publication);
    return metadata(publication);
  });
  app.get("/api/published-labels", async () => store.list<Publication>("publication").filter(p => p.published).map(metadata));
  app.get("/api/published-labels/:id", async request => metadata(currentPublication((request.params as any).id)));
  app.get("/api/published-labels/:id/csv", async (request, reply) => {
    const publication = currentPublication((request.params as any).id);
    if (!publication.fields.length) throw fail("Static labels do not require CSV");
    return reply.type("text/csv; charset=utf-8").header("Content-Disposition", 'attachment; filename="label-data.csv"').send(csvHeaders(publication.fields));
  });
  app.post("/api/printer/preparations", async request => {
    const parsed = prepareSchema.safeParse(request.body);
    if (!parsed.success) throw fail("Invalid print preparation request");
    const body = parsed.data;
    const publication = currentPublication(body.publicationId, body.version);
    const printer = await currentPrinter(body.printerId);
    if (!printer?.host) throw fail("Choose a configured printer");
    if ((printer.location ?? null) !== body.location) throw fail("Printer location changed; refresh and select a printer again", 409);
    let rows: Record<string, string>[];
    if (publication.fields.length) {
      if (body.quantity !== undefined || body.csv === undefined) throw fail("Variable labels require CSV and do not accept quantity overrides");
      try { rows = parseLabelCsv(body.csv, publication.fields); } catch (error) { throw fail((error as Error).message); }
    } else {
      if (body.csv !== undefined) throw fail("Static labels do not accept CSV");
      rows = [{}];
    }
    const compilationIds: string[] = [];
    try {
      for (const [index, data] of rows.entries()) {
        const quantity = publication.fields.length ? 1 : body.quantity ?? 1;
        const result = await compileProject(publication.project, publication.templateId, data, printer, assetsDir, { quantity });
        const errors = result.diagnostics.filter(d => d.severity === "error");
        if (errors.length) throw fail(`Row ${index + 1}: ${errors.map(d => d.message).join("; ")}`);
        const id = randomUUID();
        store.put("compilation", id, { ...result, id, userId: identityOf(request).id, source: "published", publicationId: publication.id,
          version: publication.version, project: publication.project, printer, data, quantity, createdAt: new Date().toISOString() });
        compilationIds.push(id);
      }
      currentPublication(publication.id, publication.version);
      const preparation: Preparation = { id: randomUUID(), userId: identityOf(request).id, publicationId: publication.id,
        version: publication.version, compilationIds, count: publication.fields.length ? rows.length : body.quantity ?? 1, createdAt: new Date().toISOString() };
      store.put("preparation", preparation.id, preparation);
      return { id: preparation.id, count: preparation.count, rows: rows.length, diagnostics: [] };
    } catch (error) {
      for (const id of compilationIds) store.delete("compilation", id);
      throw error;
    }
  });
  app.get("/api/printer/preparations/:id/previews", async request => {
    const preparation = ownedPreparation(request, (request.params as any).id);
    const query = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(20).default(1) }).safeParse(request.query);
    if (!query.success) throw fail("Invalid preview page");
    return { total: preparation.compilationIds.length, previews: preparation.compilationIds.slice(query.data.offset, query.data.offset + query.data.limit).map((id, index) => {
      const c = store.get("compilation", id);
      return { row: query.data.offset + index + 1, previewBase64: c.previewBase64, widthDots: c.widthDots, heightDots: c.heightDots, diagnostics: c.diagnostics };
    }) };
  });
  app.post("/api/printer/submissions", async request => {
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success) throw fail("Invalid print submission request");
    const body = parsed.data, identity = identityOf(request);
    const preparation = ownedPreparation(request, body.preparationId);
    const existing = () => store.list("batch").find(b => b.userId === identity.id && b.idempotencyKey === body.idempotencyKey);
    const duplicate = () => {
      const batch = existing();
      if (!batch) return;
      if (batch.preparationId !== preparation.id) throw fail("Idempotency key already used for another preparation", 409);
      return batchResponse(batch);
    };
    const prior = duplicate();
    if (prior) return prior;
    currentPublication(preparation.publicationId, preparation.version);
    const first = store.get("compilation", preparation.compilationIds[0]);
    const printers = new Map([[first.printer.id, await currentPrinter(first.printer.id)]]);
    const compilations = await Promise.all(preparation.compilationIds.map(id => printableCompilation(id, printers)));
    // Recheck after asynchronous printer validation, then enqueue without yielding.
    currentPublication(preparation.publicationId, preparation.version);
    const raced = duplicate();
    if (raced) return raced;
    const id = randomUUID();
    const jobs = compilations.map((c, index) => newJob(c, identity.id, `${body.idempotencyKey}:${index}`, id));
    const batch = { id, userId: identity.id, preparationId: preparation.id, idempotencyKey: body.idempotencyKey,
      compilationIds: preparation.compilationIds, jobIds: jobs.map(j => j.id), createdAt: new Date().toISOString() };
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const job of jobs) store.put("job", job.id, job);
      store.put("batch", id, batch);
      store.db.exec("COMMIT");
    } catch (error) { store.db.exec("ROLLBACK"); throw error; }
    queue.kick(first.printer.id);
    return batchResponse(batch);
  });
  app.post("/api/printer/jobs/:id/reprint", async request => {
    const body = z.object({ idempotencyKey: z.string().min(1).max(200) }).strict().safeParse(request.body);
    if (!body.success) throw fail("Idempotency key required");
    const job = store.get<PrintJob>("job", (request.params as any).id);
    if (!job) throw fail("Job not found", 404);
    const identity = identityOf(request);
    requireOwner(identity, job);
    if (!["sent", "failed", "outcome-unknown", "cancelled"].includes(job.state)) throw fail("Wait for the original job to finish before reprinting", 409);
    const lookup = () => store.jobSummaries().find(j => j.userId === identity.id && j.idempotencyKey === body.data.idempotencyKey);
    const duplicate = () => {
      const prior = lookup();
      if (!prior) return;
      if (prior.reprintOf !== job.id) throw fail("Idempotency key already used", 409);
      return prior;
    };
    const prior = duplicate();
    if (prior) return prior;
    const c = await printableCompilation(job.compilationId);
    if (c.source !== "published") requireAdmin(identity);
    else currentPublication(c.publicationId, c.version);
    const raced = duplicate();
    if (raced) return raced;
    const reprint = { ...newJob(c, identity.id, body.data.idempotencyKey), reprintOf: job.id };
    store.put("job", reprint.id, reprint);
    queue.kick(c.printer.id);
    return store.jobSummary(reprint.id);
  });
}
