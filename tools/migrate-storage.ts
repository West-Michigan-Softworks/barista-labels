import { readMigrationSource, migrateToSql } from "../server/migration.js";
import { SqlStorage } from "../server/sql-storage.js";

const args = process.argv.slice(2);
const allowed = new Set(["--validate-only", "--server-stopped"]);
if (
  args.some((arg) => !allowed.has(arg)) ||
  !args.includes("--server-stopped")
) {
  console.error(
    "Usage: npm run storage:migrate -- --server-stopped [--validate-only]. Stop Barista before running this command.",
  );
  process.exitCode = 1;
} else {
  let target: SqlStorage | undefined;
  try {
    const data = readMigrationSource(process.env.BARISTA_DATA_DIR ?? "data");
    target = new SqlStorage();
    await migrateToSql(data, target, args.includes("--validate-only"));
    console.log(
      `${args.includes("--validate-only") ? "Validated" : "Migrated and verified"}: ${data.records.length} records, ${data.revisions.length} revisions, ${data.assets.length} assets.`,
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await target?.close().catch(() => {});
  }
}
