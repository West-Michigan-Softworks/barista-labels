import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Storage } from "./storage.js";
import type { PrintQueue, PrintJob } from "./queue.js";
import { requireAdmin, requireOwner, type Identity } from "./auth.js";
import { compileProject } from "./render.js";
import {
  csvHeaders,
  labelFields,
  labelSources,
  parseLabelCsv,
  type Publication,
} from "../shared/publishing.js";
import type { Project, PrinterProfile } from "../shared/model.js";
const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
const metadata = ({ project, ...label }: Publication) => label;
const identityOf = (request: any): Identity => request.identity;
const prepareSchema = z
  .object({
    publicationId: z.string().min(1),
    version: z.number().int().positive(),
    printerId: z.string().min(1),
    csv: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
    location: z.number().int().nullable(),
    quantity: z.number().int().min(1).max(10000).optional(),
  })
  .strict();
const submitSchema = z
  .object({
    preparationId: z.string().min(1),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
interface Preparation {
  id: string;
  userId: string;
  publicationId: string;
  version: number;
  compilationIds: string[];
  count: number;
  createdAt: string;
}
export function registerPublishing(
  app: FastifyInstance,
  context: {
    store: Storage;
    queue: PrintQueue;
    currentPrinter: (id: string) => Promise<PrinterProfile | undefined>;
    newJob: (c: any, userId: string, key: string, batchId?: string) => PrintJob;
    batchResponse: (batch: any) => Promise<any>;
    printableCompilation: (
      id: unknown,
      printers?: Map<string, any>,
    ) => Promise<any>;
  },
) {
  const {
    store,
    currentPrinter,
    queue,
    newJob,
    batchResponse,
    printableCompilation,
  } = context;
  const currentPublication = async (
    id: string,
    version?: number,
  ): Promise<Publication> => {
    const publication = await store.get<Publication>("publication", id);
    if (!publication?.published)
      throw fail("Label is no longer published; refresh the catalog", 409);
    if (version !== undefined && publication.version !== version)
      throw fail("Published label changed; refresh and prepare again", 409);
    return publication;
  };
  const ownedPreparation = async (request: any, id: string) => {
    const preparation = await store.get<Preparation>("preparation", id);
    if (!preparation) throw fail("Preparation not found", 404);
    requireOwner(identityOf(request), preparation);
    return preparation;
  };
  app.get("/api/publications", async (request) => {
    requireAdmin(identityOf(request));
    return (await store.list<Publication>("publication")).map(metadata);
  });
  app.post("/api/projects/:id/labels/:templateId/publish", async (request) => {
    requireAdmin(identityOf(request));
    const params = request.params as {
      id: string;
      templateId: string;
    };
    const body = z
      .object({ revision: z.number().int().positive() })
      .strict()
      .safeParse(request.body);
    if (!body.success) throw fail("Expected saved project revision required");
    const project = await store.get<
      Project & {
        revision: number;
      }
    >("project", params.id);
    if (!project) throw fail("Project not found", 404);
    if (project.revision !== body.data.revision)
      throw fail("Project revision conflict", 409);
    if (project.importDiagnostics.some((d) => d.severity === "error"))
      throw fail("Resolve import errors before publishing");
    let fields: string[];
    try {
      fields = labelFields(project, params.templateId);
    } catch (error) {
      throw fail((error as Error).message);
    }
    const template = project.templates.find((t) => t.id === params.templateId)!;
    const imageIds = new Set(
      template.elements.filter((e) => e.type === "image").map((e) => e.assetId),
    );
    const fonts = new Set(
      template.elements
        .filter((e) => e.type === "text")
        .map((e) => e.fontFamily),
    );
    for (const id of imageIds)
      if (!project.assets.some((a) => a.id === id))
        throw fail(`Missing image asset: ${id}`);
    const assets = project.assets.filter(
      (a) => imageIds.has(a.id) || (a.kind === "font" && fonts.has(a.name)),
    );
    for (const asset of assets) {
      const registered = await store.get("asset", asset.id);
      if (
        !/^[a-zA-Z0-9_.-]{1,150}$/.test(asset.fileName) ||
        asset.fileName.includes("..") ||
        !registered ||
        registered.fileName !== asset.fileName ||
        registered.mimeType !== asset.mimeType ||
        registered.kind !== asset.kind ||
        !(await store.readAsset(asset.fileName))
      )
        throw fail(`Missing or modified asset: ${asset.name}`);
    }
    const existing = (await store.list<Publication>("publication")).find(
      (p) => p.projectId === project.id && p.templateId === template.id,
    );
    const publication: Publication = {
      id: existing?.id ?? randomUUID(),
      name: template.name,
      projectName: project.name,
      projectId: project.id,
      templateId: template.id,
      sourceRevision: project.revision,
      version: (existing?.version ?? 0) + 1,
      published: true,
      publishedAt: new Date().toISOString(),
      publishedBy: identityOf(request).id,
      fields,
      project: {
        ...project,
        templates: [template],
        variables: labelSources(project, template.id),
        assets,
      },
    };
    // Keep each published version available independently of subsequent drafts.
    await store.put(
      "publication-version",
      `${publication.id}:${publication.version}`,
      publication,
    );
    await store.put("publication", publication.id, publication);
    return metadata(publication);
  });
  app.post("/api/publications/:id/unpublish", async (request) => {
    requireAdmin(identityOf(request));
    const publication = await store.get<Publication>(
      "publication",
      (request.params as any).id,
    );
    if (!publication) throw fail("Publication not found", 404);
    publication.published = false;
    await store.put("publication", publication.id, publication);
    return metadata(publication);
  });
  app.get("/api/published-labels", async () =>
    (await store.list<Publication>("publication"))
      .filter((p) => p.published)
      .map(metadata),
  );
  app.get("/api/published-labels/:id", async (request) =>
    metadata(await currentPublication((request.params as any).id)),
  );
  app.get("/api/published-labels/:id/csv", async (request, reply) => {
    const publication = await currentPublication((request.params as any).id);
    if (!publication.fields.length)
      throw fail("Static labels do not require CSV");
    return reply
      .type("text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="label-data.csv"')
      .send(csvHeaders(publication.fields));
  });
  app.post("/api/printer/preparations", async (request) => {
    const parsed = prepareSchema.safeParse(request.body);
    if (!parsed.success) throw fail("Invalid print preparation request");
    const body = parsed.data;
    const publication = await currentPublication(
      body.publicationId,
      body.version,
    );
    const printer = await currentPrinter(body.printerId);
    if (!printer?.host) throw fail("Choose a configured printer");
    if ((printer.location ?? null) !== body.location)
      throw fail(
        "Printer location changed; refresh and select a printer again",
        409,
      );
    let rows: Record<string, string>[];
    if (publication.fields.length) {
      if (body.quantity !== undefined || body.csv === undefined)
        throw fail(
          "Variable labels require CSV and do not accept quantity overrides",
        );
      try {
        rows = parseLabelCsv(body.csv, publication.fields);
      } catch (error) {
        throw fail((error as Error).message);
      }
    } else {
      if (body.csv !== undefined) throw fail("Static labels do not accept CSV");
      rows = [{}];
    }
    const compilationIds: string[] = [];
    try {
      for (const [index, data] of rows.entries()) {
        const quantity = publication.fields.length ? 1 : (body.quantity ?? 1);
        const result = await compileProject(
          publication.project,
          publication.templateId,
          data,
          printer,
          store,
          { quantity },
        );
        const errors = result.diagnostics.filter((d) => d.severity === "error");
        if (errors.length)
          throw fail(
            `Row ${index + 1}: ${errors.map((d) => d.message).join("; ")}`,
          );
        const id = randomUUID();
        await store.put("compilation", id, {
          ...result,
          id,
          userId: identityOf(request).id,
          source: "published",
          publicationId: publication.id,
          version: publication.version,
          project: publication.project,
          printer,
          data,
          quantity,
          createdAt: new Date().toISOString(),
        });
        compilationIds.push(id);
      }
      await currentPublication(publication.id, publication.version);
      const preparation: Preparation = {
        id: randomUUID(),
        userId: identityOf(request).id,
        publicationId: publication.id,
        version: publication.version,
        compilationIds,
        count: publication.fields.length ? rows.length : (body.quantity ?? 1),
        createdAt: new Date().toISOString(),
      };
      await store.put("preparation", preparation.id, preparation);
      return {
        id: preparation.id,
        count: preparation.count,
        rows: rows.length,
        diagnostics: [],
      };
    } catch (error) {
      for (const id of compilationIds) await store.delete("compilation", id);
      throw error;
    }
  });
  app.get("/api/printer/preparations/:id/previews", async (request) => {
    const preparation = await ownedPreparation(
      request,
      (request.params as any).id,
    );
    const query = z
      .object({
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(20).default(1),
      })
      .safeParse(request.query);
    if (!query.success) throw fail("Invalid preview page");
    return {
      total: preparation.compilationIds.length,
      previews: await Promise.all(
        preparation.compilationIds
          .slice(query.data.offset, query.data.offset + query.data.limit)
          .map(async (id, index) => {
            const c = await store.get("compilation", id);
            return {
              row: query.data.offset + index + 1,
              previewBase64: c.previewBase64,
              widthDots: c.widthDots,
              heightDots: c.heightDots,
              diagnostics: c.diagnostics,
            };
          }),
      ),
    };
  });
  app.post("/api/printer/submissions", async (request) => {
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success) throw fail("Invalid print submission request");
    const body = parsed.data,
      identity = identityOf(request);
    const preparation = await ownedPreparation(request, body.preparationId);
    const existing = async () =>
      (await store.list("batch")).find(
        (b) =>
          b.userId === identity.id && b.idempotencyKey === body.idempotencyKey,
      );
    const duplicate = async () => {
      const batch = await existing();
      if (!batch) return;
      if (batch.preparationId !== preparation.id)
        throw fail("Idempotency key already used for another preparation", 409);
      return await batchResponse(batch);
    };
    const prior = await duplicate();
    if (prior) return prior;
    await currentPublication(preparation.publicationId, preparation.version);
    const first = await store.get("compilation", preparation.compilationIds[0]);
    const printers = new Map([
      [first.printer.id, await currentPrinter(first.printer.id)],
    ]);
    const compilations = await Promise.all(
      preparation.compilationIds.map((id) =>
        printableCompilation(id, printers),
      ),
    );
    // Recheck publication and idempotency inside the mutation transaction.
    await currentPublication(preparation.publicationId, preparation.version);
    const raced = await duplicate();
    if (raced) return raced;
    const id = randomUUID();
    const jobs = compilations.map((c, index) =>
      newJob(c, identity.id, `${body.idempotencyKey}:${index}`, id),
    );
    const batch = {
      id,
      userId: identity.id,
      preparationId: preparation.id,
      idempotencyKey: body.idempotencyKey,
      compilationIds: preparation.compilationIds,
      jobIds: jobs.map((j) => j.id),
      createdAt: new Date().toISOString(),
    };
    for (const job of jobs) await store.put("job", job.id, job);
    await store.put("batch", id, batch);
    queue.kick(first.printer.id);
    return await batchResponse(batch);
  });
  app.post("/api/printer/jobs/:id/reprint", async (request) => {
    const body = z
      .object({ idempotencyKey: z.string().min(1).max(200) })
      .strict()
      .safeParse(request.body);
    if (!body.success) throw fail("Idempotency key required");
    const job = await store.get<PrintJob>("job", (request.params as any).id);
    if (!job) throw fail("Job not found", 404);
    const identity = identityOf(request);
    requireOwner(identity, job);
    if (!["sent", "failed", "outcome-unknown", "cancelled"].includes(job.state))
      throw fail("Wait for the original job to finish before reprinting", 409);
    const lookup = async () =>
      (await store.jobSummaries()).find(
        (j) =>
          j.userId === identity.id &&
          j.idempotencyKey === body.data.idempotencyKey,
      );
    const duplicate = async () => {
      const prior = await lookup();
      if (!prior) return;
      if (prior.reprintOf !== job.id)
        throw fail("Idempotency key already used", 409);
      return prior;
    };
    const prior = await duplicate();
    if (prior) return prior;
    const c = await printableCompilation(job.compilationId);
    if (c.source !== "published") requireAdmin(identity);
    else await currentPublication(c.publicationId, c.version);
    const raced = await duplicate();
    if (raced) return raced;
    const reprint = {
      ...newJob(c, identity.id, body.data.idempotencyKey),
      reprintOf: job.id,
    };
    await store.put("job", reprint.id, reprint);
    queue.kick(c.printer.id);
    return await store.jobSummary(reprint.id);
  });
}
