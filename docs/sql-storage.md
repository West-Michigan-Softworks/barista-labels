# SQL Server application storage

Select `BARISTA_STORAGE_BACKEND=sqlite|sqlserver`. SQLite is the default; SQL mode
does not open/create SQLite and never falls back during a SQL outage.

## Provision in SSMS

Use SQL Server **2016+**, database compatibility level **130+**. Open each script
in `sql/`, enable **Query > SQLCMD Mode**, and edit `BaristaDatabase` at the top of
**each** script to match `BARISTA_SQL_DATABASE`. Run as a provisioning administrator:

1. `001-create-database.sql`: optional; creates the database only if missing.
2. `002-schema.sql`: schema, tables, indexes, and schema version.
3. `003-procedures.sql`: installs or updates stored procedures.
4. `004-permissions.sql`: application and migration roles/procedure grants.

Scripts are repeatable, preserve application data, and stop on errors in SQLCMD
mode. Upgrade compatibility below 130 before installation. Runtime checks the
installed schema version; it does not provision objects.

Create a SQL-authenticated server login in SSMS, map it to a database user, and
add that user to `barista_app`. The service needs procedure execution, not direct
table/DDL permissions or `db_owner`. After creating the login, for example:

```sql
USE [Barista]; -- your chosen name
CREATE USER [BaristaService] FOR LOGIN [BaristaService];
ALTER ROLE barista_app ADD MEMBER [BaristaService];
```

The `barista` schema contains `Records` (JSON plus stable insertion sequence),
`ProjectRevisions`, `AssetBlobs` (binary image/font/import content), and
`SchemaVersion`. Identifiers allow 320 UTF-16 code units, record kinds 64, and
asset filenames 150. Migration validates these limits before writing.

## Configure

Use the server's ignored `.env`, with settings from `.env.example`:

```dotenv
BARISTA_STORAGE_BACKEND=sqlserver
BARISTA_SQL_SERVER=your-server
BARISTA_SQL_DATABASE=Barista
BARISTA_SQL_PORT=1433
BARISTA_SQL_USER=BaristaService
BARISTA_SQL_PASSWORD=your-password
BARISTA_SQL_ENCRYPT=true
BARISTA_SQL_TRUST_SERVER_CERTIFICATE=false
```

SSMS scripts do not read `.env`; set their database variable to the same name.
SQL authentication uses the existing `mssql` driver over TCP. Install a trusted
server certificate; certificate trust override is available for an approved
internal setup. Credentials and underlying driver errors are not exposed to clients.

`SQL_PRINTERS_*` remains independent: the printer catalog can keep its read-only
connection to `BYAPPS.LabelPrint.dbo.printersZPL` while application storage uses
another database/login. Business-table lookups for label values are not included.

Deploy **one active Barista process per application database**. Transactions
preserve revisions, publication snapshots, and idempotent submissions. Workers
persist `sending` before connecting to a printer. A persistence failure stops
dispatch until restart; restore database access first. Interrupted `sending` jobs
become `outcome-unknown`, requiring explicit reprint. `Sent` means transmission,
not physical printing.

Images/fonts are read directly from storage during rendering. SQL mode has no
persistent local asset mirror. `BARISTA_DATA_DIR` remains available for local
cache/temporary needs and for SQLite mode's database/assets.

## Offline migration and cutover

1. Stop Barista. Back up SQLite and its assets directory together. Keep all
   instances stopped through validation, migration, and cutover.
2. Provision SQL objects; `Records`, `ProjectRevisions`, and `AssetBlobs` must be
   empty. Keep the schema version row.
3. Set `BARISTA_SQL_*` to the target and `BARISTA_DATA_DIR` to the source directory
   containing `barista.sqlite` and `assets/`. Migration reads SQLite regardless of
   the selected backend.
4. Use a migration operator belonging to **both** `barista_app` and
   `barista_migration`, with its credentials temporarily in `.env`.
5. Run validation, then migration:

```powershell
npm run storage:migrate -- --server-stopped --validate-only
npm run storage:migrate -- --server-stopped
```

`--server-stopped` confirms that the operator stopped the service; the command
cannot detect every remotely running process. Validation opens the source
read-only without checkpointing it, checks referenced files, content-addressed
hashes and declared sizes, and rejects populated targets. Migration preserves
exact JSON, IDs, revisions, insertion order, and all asset files, including
unreferenced files. It verifies target content/counts before committing and rolls
back on failure. It never merges data or modifies the SQLite source.

6. Revoke `barista_migration` membership, restore runtime credentials, set
   `BARISTA_STORAGE_BACKEND=sqlserver`, and start Barista. Check templates,
   publications, assets, and job states. Retained queued jobs may dispatch when
   the service starts.

To return to the original local data, stop Barista and select `sqlite`. SQL changes
are not copied back; the two stores are independent. Back up SQL using normal
SQL Server backups (records and asset bytes are in the same database). Protect
`.env` separately. SQLite backups still require database and assets together.

## Verification

Run `npm run check`, `npm run build`, and `npm test`. Live integration is opt-in:
use an **empty disposable database** named `BaristaTest_*`, with a test administrator
able to run the schema scripts. Set `BARISTA_SQL_TEST_SERVER`,
`BARISTA_SQL_TEST_DATABASE`, `BARISTA_SQL_TEST_USER`, `BARISTA_SQL_TEST_PASSWORD`,
and optionally `_PORT`, `_ENCRYPT`, `_TRUST_SERVER_CERTIFICATE`. Run
`npx tsx --test tests/sql-storage.integration.test.ts`. It installs scripts twice,
checks migration/application behavior, and leaves test data in that disposable
database. Normal tests contact neither SQL Server nor physical printers.

Implementation verification passed type checking, production build, and the local
test suite. Live SQL Server execution was not available during implementation;
run the opt-in integration test before production cutover.

See Microsoft's [SQL Server JSON documentation](https://learn.microsoft.com/en-us/sql/relational-databases/json/json-data-sql-server)
and [node-mssql connection/transaction documentation](https://github.com/tediousjs/node-mssql).
