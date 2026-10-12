import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export class Store {
  db: DatabaseSync;
  constructor(public directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "barista.sqlite"));
    this.db.exec(
      `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS revisions(project_id TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(project_id,revision));`,
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS queue_jobs_state_printer ON records(json_extract(value,'$.state'),json_extract(value,'$.printer.id')) WHERE kind='job';",
    );
  }
  get<T = any>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM records WHERE kind=? AND id=?")
      .get(kind, id) as any;
    return row ? JSON.parse(row.value) : undefined;
  }
  list<T = any>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT value FROM records WHERE kind=? ORDER BY rowid DESC")
        .all(kind) as any[]
    ).map((row) => JSON.parse(row.value));
  }
  nextQueuedJob(printerId: string): any | undefined {
    const row = this.db
      .prepare(
        "SELECT value FROM records WHERE kind='job' AND json_extract(value,'$.state')='queued' AND json_extract(value,'$.printer.id')=? ORDER BY rowid LIMIT 1",
      )
      .get(printerId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  jobSummaries(): any[] {
    return (
      this.db
        .prepare(
          "SELECT json_remove(value,'$.zpl') AS value FROM records WHERE kind='job' ORDER BY rowid DESC",
        )
        .all() as { value: string }[]
    ).map((row) => JSON.parse(row.value));
  }
  jobSummary(id: string): any | undefined {
    const row = this.db
      .prepare(
        "SELECT json_remove(value,'$.zpl') AS value FROM records WHERE kind='job' AND id=?",
      )
      .get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  jobsInState(state: string): any[] {
    return (
      this.db
        .prepare(
          "SELECT value FROM records WHERE kind='job' AND json_extract(value,'$.state')=?",
        )
        .all(state) as { value: string }[]
    ).map((row) => JSON.parse(row.value));
  }
  queuedPrinterIds(): string[] {
    return (
      this.db
        .prepare(
          "SELECT DISTINCT json_extract(value,'$.printer.id') AS id FROM records WHERE kind='job' AND json_extract(value,'$.state')='queued'",
        )
        .all() as { id: string }[]
    ).map((row) => row.id);
  }
  put(kind: string, id: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",
      )
      .run(kind, id, JSON.stringify(value));
  }
  delete(kind: string, id: string) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  saveProject(project: any, expected: number | undefined) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.get("project", project.id);
      if (
        (old && expected !== old.revision) ||
        (!old && expected !== undefined && expected !== 0)
      )
        throw Object.assign(new Error("Project revision conflict"), {
          statusCode: 409,
        });
      const latest = this.db
        .prepare(
          "SELECT MAX(revision) AS revision FROM revisions WHERE project_id=?",
        )
        .get(project.id) as { revision: number | null };
      const value = {
        ...project,
        revision: (old?.revision ?? latest.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      this.put("project", project.id, value);
      this.db
        .prepare("INSERT INTO revisions VALUES(?,?,?)")
        .run(project.id, value.revision, JSON.stringify(value));
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  revisions(id: string) {
    return (
      this.db
        .prepare(
          "SELECT revision,value FROM revisions WHERE project_id=? ORDER BY revision DESC",
        )
        .all(id) as any[]
    ).map((row) => ({
      revision: row.revision,
      project: JSON.parse(row.value),
    }));
  }
  close() {
    this.db.close();
  }
}
