import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./store.js";
import { SqlStorage } from "./sql-storage.js";

export interface StorageBackend {
  initialize(): Promise<void>;
  get<T = any>(
    kind: string,
    id: string,
  ): T | undefined | Promise<T | undefined>;
  list<T = any>(kind: string): T[] | Promise<T[]>;
  put(kind: string, id: string, value: unknown): void | Promise<void>;
  delete(kind: string, id: string): void | Promise<void>;
  saveProject(project: any, expected: number | undefined): any;
  revisions(id: string): any[] | Promise<any[]>;
  nextQueuedJob(printerId: string): any;
  jobSummaries(): any[] | Promise<any[]>;
  jobSummary(id: string): any;
  jobsInState(state: string): any[] | Promise<any[]>;
  queuedPrinterIds(): string[] | Promise<string[]>;
  readAsset(id: string): Buffer | undefined | Promise<Buffer | undefined>;
  writeAsset(id: string, bytes: Buffer): void | Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void | Promise<void>;
}

function assetId(id: string) {
  if (!/^[a-zA-Z0-9_.-]{1,150}$/.test(id) || id.includes(".."))
    throw Object.assign(new Error("Invalid asset identifier"), {
      statusCode: 400,
    });
  return id;
}

export class SqliteStorage implements StorageBackend {
  readonly raw: Store;
  readonly assetsDir: string;
  constructor(directory: string) {
    this.raw = new Store(directory);
    this.assetsDir = join(directory, "assets");
    mkdirSync(this.assetsDir, { recursive: true });
  }
  async initialize() {}
  get<T = any>(kind: string, id: string): T | undefined {
    return this.raw.get<T>(kind, id);
  }
  list<T = any>(kind: string): T[] {
    return this.raw.list<T>(kind);
  }
  put(kind: string, id: string, value: unknown) {
    this.raw.put(kind, id, value);
  }
  delete(kind: string, id: string) {
    this.raw.delete(kind, id);
  }
  saveProject(project: any, expected: number | undefined) {
    return this.raw.saveProject(project, expected, true);
  }
  revisions(id: string) {
    return this.raw.revisions(id);
  }
  nextQueuedJob(id: string) {
    return this.raw.nextQueuedJob(id);
  }
  jobSummaries() {
    return this.raw.jobSummaries();
  }
  jobSummary(id: string) {
    return this.raw.jobSummary(id);
  }
  jobsInState(state: string) {
    return this.raw.jobsInState(state);
  }
  queuedPrinterIds() {
    return this.raw.queuedPrinterIds();
  }
  readAsset(id: string) {
    const file = join(this.assetsDir, assetId(id));
    return existsSync(file) ? readFileSync(file) : undefined;
  }
  writeAsset(id: string, bytes: Buffer) {
    writeFileSync(join(this.assetsDir, assetId(id)), bytes);
  }
  async begin() {
    this.raw.db.exec("BEGIN IMMEDIATE");
  }
  async commit() {
    this.raw.db.exec("COMMIT");
  }
  async rollback() {
    this.raw.db.exec("ROLLBACK");
  }
  close() {
    this.raw.close();
  }
}

/** Serialize access, including reads, so unrelated requests never join a transaction.
 * Transaction context expires on completion: detached queue/import tasks must wait
 * for the commit instead of inheriting access to a completed transaction. */
export class Storage {
  private tail: Promise<unknown> = Promise.resolve();
  private context = new AsyncLocalStorage<{
    active: boolean;
    committed: (() => void)[];
    pending: Set<Promise<unknown>>;
  }>();
  constructor(readonly backend: StorageBackend) {}
  async initialize() {
    await this.backend.initialize();
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const scope = this.context.getStore();
    if (scope?.active) {
      const operation = work();
      scope.pending.add(operation);
      try {
        return await operation;
      } finally {
        scope.pending.delete(operation);
      }
    }
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.active) return this.exclusive(work);
    return this.exclusive(async () => {
      await this.backend.begin();
      const scope = {
        active: true,
        committed: [] as (() => void)[],
        pending: new Set<Promise<unknown>>(),
      };
      const drain = async () => {
        while (scope.pending.size) await Promise.allSettled([...scope.pending]);
      };
      try {
        const result = await this.context.run(scope, work);
        await drain();
        await this.backend.commit();
        scope.active = false;
        for (const callback of scope.committed) callback();
        return result;
      } catch (error) {
        await drain();
        await this.backend.rollback().catch(() => {});
        throw error;
      } finally {
        scope.active = false;
      }
    });
  }
  afterCommit(work: () => void) {
    const scope = this.context.getStore();
    if (scope?.active) scope.committed.push(work);
    else work();
  }
  get<T = any>(kind: string, id: string): Promise<T | undefined> {
    return this.exclusive(async () => this.backend.get<T>(kind, id));
  }
  list<T = any>(kind: string): Promise<T[]> {
    return this.exclusive(async () => this.backend.list<T>(kind));
  }
  put(kind: string, id: string, value: unknown) {
    return this.transaction(async () => this.backend.put(kind, id, value));
  }
  delete(kind: string, id: string) {
    return this.transaction(async () => this.backend.delete(kind, id));
  }
  saveProject(project: any, expected: number | undefined) {
    if (
      expected !== undefined &&
      (!Number.isInteger(expected) || expected < 0 || expected > 2147483647)
    )
      return Promise.reject(
        Object.assign(new Error("Project revision conflict"), {
          statusCode: 409,
        }),
      );
    return this.transaction(async () =>
      this.backend.saveProject(project, expected),
    );
  }
  revisions(id: string) {
    return this.exclusive(async () => this.backend.revisions(id));
  }
  nextQueuedJob(id: string) {
    return this.exclusive(async () => this.backend.nextQueuedJob(id));
  }
  jobSummaries() {
    return this.exclusive(async () => this.backend.jobSummaries());
  }
  jobSummary(id: string) {
    return this.exclusive(async () => this.backend.jobSummary(id));
  }
  jobsInState(state: string) {
    return this.exclusive(async () => this.backend.jobsInState(state));
  }
  queuedPrinterIds() {
    return this.exclusive(async () => this.backend.queuedPrinterIds());
  }
  readAsset(id: string) {
    return this.exclusive(async () => this.backend.readAsset(assetId(id)));
  }
  writeAsset(id: string, bytes: Buffer) {
    return this.transaction(async () =>
      this.backend.writeAsset(assetId(id), bytes),
    );
  }
  close() {
    return this.exclusive(async () => this.backend.close());
  }
}

export function createStorage(directory: string, env = process.env): Storage {
  const backend = env.BARISTA_STORAGE_BACKEND ?? "sqlite";
  if (backend === "sqlite") return new Storage(new SqliteStorage(directory));
  if (backend === "sqlserver") return new Storage(new SqlStorage(env));
  throw new Error("BARISTA_STORAGE_BACKEND must be sqlite or sqlserver");
}
