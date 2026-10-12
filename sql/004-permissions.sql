-- SSMS: enable SQLCMD Mode; match BARISTA_SQL_DATABASE.
:setvar BaristaDatabase "Barista"
:on error exit
USE [$(BaristaDatabase)];
GO
IF DATABASE_PRINCIPAL_ID(N'barista_app') IS NULL CREATE ROLE barista_app AUTHORIZATION dbo;
IF DATABASE_PRINCIPAL_ID(N'barista_migration') IS NULL CREATE ROLE barista_migration AUTHORIZATION dbo;
GO
GRANT EXECUTE ON OBJECT::barista.SchemaCheck TO barista_app;
GRANT EXECUTE ON OBJECT::barista.TransactionLock TO barista_app;
GRANT EXECUTE ON OBJECT::barista.RecordGet TO barista_app;
GRANT EXECUTE ON OBJECT::barista.RecordList TO barista_app;
GRANT EXECUTE ON OBJECT::barista.RecordPut TO barista_app;
GRANT EXECUTE ON OBJECT::barista.RecordDelete TO barista_app;
GRANT EXECUTE ON OBJECT::barista.ProjectSave TO barista_app;
GRANT EXECUTE ON OBJECT::barista.RevisionList TO barista_app;
GRANT EXECUTE ON OBJECT::barista.JobQuery TO barista_app;
GRANT EXECUTE ON OBJECT::barista.AssetGet TO barista_app;
GRANT EXECUTE ON OBJECT::barista.AssetPut TO barista_app;
GRANT EXECUTE ON OBJECT::barista.MigrationSnapshot TO barista_migration;
GRANT EXECUTE ON OBJECT::barista.MigrationRecord TO barista_migration;
GRANT EXECUTE ON OBJECT::barista.MigrationRevision TO barista_migration;
-- Provision a SQL login separately; map it to a database user and add to barista_app.
-- Example (replace names; passwords never belong in these committed scripts):
-- CREATE USER [BaristaService] FOR LOGIN [BaristaService];
-- ALTER ROLE barista_app ADD MEMBER [BaristaService];
-- Temporarily add a migration operator to BOTH roles, then revoke barista_migration.
GO
