import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import sql from "mssql";
import { SqlStorage } from "./sql-storage.js";

export interface MigrationData {
  records: { Kind: string; Id: string; Value: string; Sequence: number }[];
  revisions: { ProjectId: string; Revision: number; Value: string }[];
  assets: { Id: string; Bytes: Buffer }[];
}
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function safeFile(id: string) {
  if (!/^[a-zA-Z0-9_.-]{1,150}$/.test(id) || id.includes(".."))
    throw new Error("Unsafe source asset filename");
  return id;
}

/** Open the existing source read-only: never create, checkpoint, or modify it. */
export function readMigrationSource(directory: string): MigrationData {
  const database = join(resolve(directory), "barista.sqlite");
  if (!existsSync(database))
    throw new Error("Source barista.sqlite does not exist");
  const source = new DatabaseSync(database, { readOnly: true });
  let records: MigrationData["records"], revisions: MigrationData["revisions"];
  try {
    records = source
      .prepare(
        "SELECT kind AS Kind,id AS Id,value AS Value,rowid AS Sequence FROM records ORDER BY rowid",
      )
      .all() as unknown as MigrationData["records"];
    revisions = source
      .prepare(
        "SELECT project_id AS ProjectId,revision AS Revision,value AS Value FROM revisions ORDER BY project_id,revision",
      )
      .all() as unknown as MigrationData["revisions"];
  } finally {
    source.close();
  }
  const metadata: any[] = [];
  function inspect(value: any) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value.assets)) metadata.push(...value.assets);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(inspect);
      else inspect(child);
    }
  }
  for (const row of records) {
    if (
      !row.Kind ||
      row.Kind.length > 64 ||
      !row.Id ||
      row.Id.length > 320 ||
      !Number.isSafeInteger(row.Sequence) ||
      row.Sequence < 1
    )
      throw new Error("Source record exceeds SQL storage limits");
    const value = JSON.parse(row.Value);
    if (row.Kind === "asset") metadata.push(value);
    inspect(value);
  }
  for (const row of revisions) {
    if (
      !row.ProjectId ||
      row.ProjectId.length > 320 ||
      !Number.isInteger(row.Revision) ||
      row.Revision < 1 ||
      row.Revision > 2147483647
    )
      throw new Error("Invalid source revision");
    inspect(JSON.parse(row.Value));
  }
  const assetsDir = join(resolve(directory), "assets");
  const files = new Set(metadata.map((asset) => safeFile(asset.fileName)));
  if (existsSync(assetsDir))
    for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
      if (!entry.isFile())
        throw new Error("Unexpected non-file entry in source asset directory");
      files.add(safeFile(entry.name));
    }
  const assets = [...files].sort().map((Id) => {
    const file = join(assetsDir, Id);
    if (!existsSync(file)) throw new Error(`Missing source asset: ${Id}`);
    const Bytes = readFileSync(file);
    if (/^[a-f0-9]{64}$/.test(Id) && hash(Bytes) !== Id)
      throw new Error(`Source asset hash mismatch: ${Id}`);
    for (const asset of metadata.filter((asset) => asset.fileName === Id)) {
      if (/^[a-f0-9]{64}$/.test(asset.id) && hash(Bytes) !== asset.id)
        throw new Error(`Source asset hash mismatch: ${Id}`);
      if (asset.size !== undefined && asset.size !== Bytes.length)
        throw new Error(`Source asset size mismatch: ${Id}`);
    }
    return { Id, Bytes };
  });
  return { records, revisions, assets };
}

export function verifyMigration(data: MigrationData, actual: MigrationData) {
  const normalize = (values: object[]) =>
    values.map((value) => JSON.stringify(value)).sort();
  const record = (row: MigrationData["records"][number]) => ({
    Kind: row.Kind,
    Id: row.Id,
    Value: row.Value,
    Sequence: Number(row.Sequence),
  });
  const revision = (row: MigrationData["revisions"][number]) => ({
    ProjectId: row.ProjectId,
    Revision: row.Revision,
    Value: row.Value,
  });
  const asset = (row: MigrationData["assets"][number]) => ({
    Id: row.Id,
    hash: hash(row.Bytes),
    size: row.Bytes.length,
  });
  for (const [expected, received] of [
    [data.records.map(record), actual.records.map(record)],
    [data.revisions.map(revision), actual.revisions.map(revision)],
    [data.assets.map(asset), actual.assets.map(asset)],
  ])
    if (
      JSON.stringify(normalize(expected)) !==
      JSON.stringify(normalize(received))
    )
      throw new Error(
        "Migration verification failed; transaction will be rolled back",
      );
}

export async function migrateToSql(
  data: MigrationData,
  target: SqlStorage,
  validateOnly = false,
) {
  await target.initialize();
  await target.begin();
  try {
    const snapshot = async () => {
      const result = await target.execute("MigrationSnapshot");
      const sets = result.recordsets as sql.IRecordSet<any>[];
      return {
        records: sets[0],
        revisions: sets[1],
        assets: sets[2],
      } as MigrationData;
    };
    const existing = await snapshot();
    if (
      existing.records.length ||
      existing.revisions.length ||
      existing.assets.length
    )
      throw new Error("SQL target application tables must be empty");
    if (validateOnly) {
      await target.rollback();
      return;
    }
    // Preserve rowid ordering and exact JSON text; do not call ProjectSave.
    for (const row of data.records)
      await target.execute("MigrationRecord", {
        Kind: [sql.NVarChar(64), row.Kind],
        Id: [sql.NVarChar(320), row.Id],
        Value: [sql.NVarChar(sql.MAX), row.Value],
        Sequence: [sql.BigInt, row.Sequence],
      });
    for (const row of data.revisions)
      await target.execute("MigrationRevision", {
        ProjectId: [sql.NVarChar(320), row.ProjectId],
        Revision: [sql.Int, row.Revision],
        Value: [sql.NVarChar(sql.MAX), row.Value],
      });
    for (const row of data.assets) await target.writeAsset(row.Id, row.Bytes);
    verifyMigration(data, await snapshot());
    await target.commit();
  } catch (error) {
    await target.rollback().catch(() => {});
    throw error;
  }
}
