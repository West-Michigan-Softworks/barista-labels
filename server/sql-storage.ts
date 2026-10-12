import sql from "mssql";
import type { StorageBackend } from "./storage.js";

const unavailable = () =>
  Object.assign(
    new Error(
      "SQL application storage is unavailable; check configuration, schema, and database access.",
    ),
    {
      statusCode: 503,
      publicMessage:
        "SQL application storage is unavailable; check configuration, schema, and database access.",
    },
  );

export function sqlConfiguration(env: NodeJS.ProcessEnv): sql.config {
  for (const key of [
    "BARISTA_SQL_SERVER",
    "BARISTA_SQL_USER",
    "BARISTA_SQL_PASSWORD",
  ])
    if (!env[key]) throw new Error(`Missing required setting: ${key}`);
  const port = Number(env.BARISTA_SQL_PORT ?? 1433);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid BARISTA_SQL_PORT");
  for (const key of [
    "BARISTA_SQL_ENCRYPT",
    "BARISTA_SQL_TRUST_SERVER_CERTIFICATE",
  ])
    if (env[key] !== undefined && !["true", "false"].includes(env[key]!))
      throw new Error(`Invalid boolean setting: ${key}`);
  const database = env.BARISTA_SQL_DATABASE ?? "Barista";
  if (!database.trim() || database.length > 128)
    throw new Error("Invalid BARISTA_SQL_DATABASE");
  return {
    server: env.BARISTA_SQL_SERVER!,
    database,
    user: env.BARISTA_SQL_USER,
    password: env.BARISTA_SQL_PASSWORD,
    port,
    connectionTimeout: 10000,
    requestTimeout: 30000,
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: env.BARISTA_SQL_ENCRYPT !== "false",
      trustServerCertificate:
        env.BARISTA_SQL_TRUST_SERVER_CERTIFICATE === "true",
      abortTransactionOnError: true,
    },
  };
}

type Parameters = Record<
  string,
  [sql.ISqlType | (() => sql.ISqlType), unknown]
>;
export class SqlStorage implements StorageBackend {
  private pool: sql.ConnectionPool;
  private transaction?: sql.Transaction;
  private connecting?: Promise<sql.ConnectionPool>;
  private requestTail: Promise<void> = Promise.resolve();
  constructor(
    env = process.env,
    factory: (config: sql.config) => sql.ConnectionPool = (config) =>
      new sql.ConnectionPool(config),
  ) {
    this.pool = factory(sqlConfiguration(env));
    // Driver errors never reach logs or clients with server/credential details.
    this.pool.on("error", () => {});
  }
  private async connected() {
    if (!this.connecting)
      this.connecting = this.pool.connect().catch(() => {
        this.connecting = undefined;
        throw unavailable();
      });
    return this.connecting;
  }
  async execute(name: string, parameters: Parameters = {}) {
    // node-mssql allows only one active request on a transaction connection.
    const previous = this.requestTail;
    let release!: () => void;
    this.requestTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const request = this.transaction
        ? new sql.Request(this.transaction)
        : (await this.connected()).request();
      for (const [key, [type, value]] of Object.entries(parameters))
        request.input(key, type, value);
      return await request.execute(`barista.${name}`);
    } catch (error) {
      if ((error as any).number === 51001)
        throw Object.assign(new Error("Project revision conflict"), {
          statusCode: 409,
        });
      throw unavailable();
    } finally {
      release();
    }
  }
  async initialize() {
    try {
      const result = await this.execute("SchemaCheck");
      if (
        result.recordset[0]?.Version !== 1 ||
        result.recordset[0]?.CompatibilityLevel < 130
      )
        throw unavailable();
    } catch {
      await this.close().catch(() => {});
      throw unavailable();
    }
  }
  private identity(kind: string, id?: string): Parameters {
    if (
      !kind.length ||
      kind.length > 64 ||
      (id !== undefined && (!id.length || id.length > 320))
    )
      throw Object.assign(
        new Error("Record identifier exceeds SQL storage limits"),
        { statusCode: 400 },
      );
    return {
      Kind: [sql.NVarChar(64), kind],
      ...(id === undefined
        ? {}
        : { Id: [sql.NVarChar(320), id] as Parameters[string] }),
    };
  }
  async get<T = any>(kind: string, id: string): Promise<T | undefined> {
    const row = (await this.execute("RecordGet", this.identity(kind, id)))
      .recordset[0];
    return row ? JSON.parse(row.Value) : undefined;
  }
  async list<T = any>(kind: string): Promise<T[]> {
    return (
      await this.execute("RecordList", this.identity(kind))
    ).recordset.map((row) => JSON.parse(row.Value));
  }
  async put(kind: string, id: string, value: unknown) {
    await this.execute("RecordPut", {
      ...this.identity(kind, id),
      Value: [sql.NVarChar(sql.MAX), JSON.stringify(value)],
    });
  }
  async delete(kind: string, id: string) {
    await this.execute("RecordDelete", this.identity(kind, id));
  }
  async saveProject(project: any, expected: number | undefined) {
    this.identity("project", project.id);
    const row = (
      await this.execute("ProjectSave", {
        Id: [sql.NVarChar(320), project.id],
        Value: [sql.NVarChar(sql.MAX), JSON.stringify(project)],
        Expected: [sql.Int, expected ?? null],
        UpdatedAt: [sql.NVarChar(40), new Date().toISOString()],
      })
    ).recordset[0];
    return JSON.parse(row.Value);
  }
  async revisions(id: string) {
    const rows = (
      await this.execute("RevisionList", { Id: [sql.NVarChar(320), id] })
    ).recordset;
    return rows.map((row) => ({
      revision: row.Revision,
      project: JSON.parse(row.Value),
    }));
  }
  private async jobs(mode: string, id?: string) {
    return (
      await this.execute("JobQuery", {
        Mode: [sql.NVarChar(32), mode],
        Id: [sql.NVarChar(320), id ?? null],
      })
    ).recordset;
  }
  async nextQueuedJob(id: string) {
    const row = (await this.jobs("next", id))[0];
    return row ? JSON.parse(row.Value) : undefined;
  }
  async jobSummaries() {
    return (await this.jobs("summaries")).map((row) => JSON.parse(row.Value));
  }
  async jobSummary(id: string) {
    const row = (await this.jobs("summary", id))[0];
    return row ? JSON.parse(row.Value) : undefined;
  }
  async jobsInState(state: string) {
    return (await this.jobs("state", state)).map((row) =>
      JSON.parse(row.Value),
    );
  }
  async queuedPrinterIds() {
    return (await this.jobs("printers")).map((row) => row.Id as string);
  }
  async readAsset(id: string): Promise<Buffer | undefined> {
    return (await this.execute("AssetGet", { Id: [sql.NVarChar(150), id] }))
      .recordset[0]?.Bytes;
  }
  async writeAsset(id: string, bytes: Buffer) {
    await this.execute("AssetPut", {
      Id: [sql.NVarChar(150), id],
      Bytes: [sql.VarBinary(sql.MAX), bytes],
    });
  }
  async begin() {
    try {
      const transaction = new sql.Transaction(await this.connected());
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      this.transaction = transaction;
      await this.execute("TransactionLock");
    } catch {
      await this.rollback().catch(() => {});
      throw unavailable();
    }
  }
  async commit() {
    await this.requestTail;
    try {
      await this.transaction!.commit();
    } catch {
      throw unavailable();
    }
    this.transaction = undefined;
  }
  async rollback() {
    await this.requestTail;
    const transaction = this.transaction;
    this.transaction = undefined;
    if (transaction) await transaction.rollback();
  }
  async close() {
    await this.requestTail;
    await this.pool.close();
    this.connecting = undefined;
  }
}
