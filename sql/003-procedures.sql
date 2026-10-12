-- SSMS: enable SQLCMD Mode; match BARISTA_SQL_DATABASE.
:setvar BaristaDatabase "Barista"
:on error exit
USE [$(BaristaDatabase)];
GO
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO
IF OBJECT_ID(N'barista.SchemaCheck', N'P') IS NULL EXEC(N'CREATE PROCEDURE barista.SchemaCheck AS RETURN 0');
GO
ALTER PROCEDURE barista.SchemaCheck
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS ON;
    SET ANSI_PADDING ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;
    SET XACT_ABORT ON;
    SELECT Version, (SELECT compatibility_level FROM sys.databases WHERE database_id = DB_ID()) AS CompatibilityLevel FROM barista.SchemaVersion WHERE Id = 1;
END;
GO
IF OBJECT_ID(N'barista.TransactionLock', N'P') IS NULL EXEC(N'CREATE PROCEDURE barista.TransactionLock AS RETURN 0');
GO
ALTER PROCEDURE barista.TransactionLock
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS ON;
    SET ANSI_PADDING ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;
    SET XACT_ABORT ON;
    IF @@TRANCOUNT = 0 THROW 51000, 'An application transaction is required.', 1;
    DECLARE @result int;
    EXEC @result = sys.sp_getapplock @Resource = N'barista-storage', @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 30000;
    IF @result < 0 THROW 51000, 'Unable to acquire application storage lock.', 1;
END;
GO
IF OBJECT_ID(N'barista.RecordGet', N'P') IS NULL EXEC(N'CREATE PROCEDURE barista.RecordGet AS RETURN 0');
GO
ALTER PROCEDURE barista.RecordGet @Kind nvarchar(64), @Id nvarchar(320)
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS ON;
    SET ANSI_PADDING ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;
    SET XACT_ABORT ON;
    SELECT Value FROM barista.Records WHERE Kind = @Kind AND Id = @Id;
END;
GO
IF OBJECT_ID(N'barista.RecordList', N'P') IS NULL EXEC(N'CREATE PROCEDURE barista.RecordList AS RETURN 0');
GO
ALTER PROCEDURE barista.RecordList @Kind nvarchar(64)
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS ON;
    SET ANSI_PADDING ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;
    SET XACT_ABORT ON;
    SELECT Value FROM barista.Records WHERE Kind = @Kind ORDER BY Sequence DESC;
END;
GO
IF OBJECT_ID(N'barista.RecordPut', N'P') IS NULL EXEC(N'CREATE PROCEDURE barista.RecordPut AS RETURN 0');
GO
ALTER PROCEDURE barista.RecordPut @Kind nvarchar(64), @Id nvarchar(320), @Value nvarchar(max)
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS ON;
    SET ANSI_PADDING ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;
    SET XACT_ABORT ON;
    UPDATE barista.Records WITH (UPDLOCK, SERIALIZABLE) SET Value = @Value WHERE Kind = @Kind AND Id = @Id;
    IF @@ROWCOUNT = 0 INSERT barista.Records(Kind, Id, Value) VALUES (@Kind, @Id, @Value);
END;
GO
IF OBJECT_ID(N'barista.RecordDelete', N'P') IS NULL EXEC(N'CREATE PROCEDURE barista.RecordDelete AS RETURN 0');
GO
ALTER PROCEDURE barista.RecordDelete @Kind nvarchar(64), @Id nvarchar(320)
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS ON;
    SET ANSI_PADDING ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;
    SET XACT_ABORT ON;
    DELETE barista.Records WHERE Kind = @Kind AND Id = @Id;
END;
GO
IF OBJECT_ID(N'barista.ProjectSave', N'P') IS NULL EXEC(N'CREATE PROCEDURE barista.ProjectSave AS RETURN 0');
GO
ALTER PROCEDURE barista.ProjectSave @Id nvarchar(320), @Value nvarchar(max), @Expected int = NULL, @UpdatedAt nvarchar(40)
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS ON;
    SET ANSI_PADDING ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;
    SET XACT_ABORT ON;
    IF @@TRANCOUNT = 0 THROW 51000, 'An application transaction is required.', 1;
    DECLARE @old nvarchar(max), @revision int;
    SELECT @old = Value FROM barista.Records WITH (UPDLOCK, HOLDLOCK) WHERE Kind = N'project' AND Id = @Id;
    IF (@old IS NOT NULL AND (@Expected IS NULL OR @Expected <> CONVERT(int, JSON_VALUE(@old, '$.revision'))))
       OR (@old IS NULL AND @Expected IS NOT NULL AND @Expected <> 0)
        THROW 51001, 'Project revision conflict', 1;
    SELECT @revision = COALESCE(CONVERT(int, JSON_VALUE(@old, '$.revision')), MAX(Revision), 0) + 1 FROM barista.ProjectRevisions WHERE ProjectId = @Id;
    SET @Value = JSON_MODIFY(JSON_MODIFY(@Value, '$.revision', @revision), '$.updatedAt', @UpdatedAt);
    EXEC barista.RecordPut @Kind = N'project', @Id = @Id, @Value = @Value;
    INSERT barista.ProjectRevisions(ProjectId, Revision, Value) VALUES (@Id, @revision, @Value);
    SELECT @Value AS Value;
END;
GO
IF OBJECT_ID(N'barista.RevisionList', N'P') IS NULL EXEC(N'CREATE PROCEDURE barista.RevisionList AS RETURN 0');
GO
ALTER PROCEDURE barista.RevisionList @Id nvarchar(320)
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS ON;
    SET ANSI_PADDING ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;
    SET XACT_ABORT ON;
    SELECT Revision, Value FROM barista.ProjectRevisions WHERE ProjectId = @Id ORDER BY Revision DESC;
END;
GO
IF OBJECT_ID(N'barista.JobQuery', N'P') IS NULL EXEC(N'CREATE PROCEDURE barista.JobQuery AS RETURN 0');
GO
ALTER PROCEDURE barista.JobQuery @Mode nvarchar(32), @Id nvarchar(320) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS ON;
    SET ANSI_PADDING ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;
    SET XACT_ABORT ON;
    IF @Mode = N'next'
        SELECT TOP (1) Value FROM barista.Records WHERE Kind = N'job' AND JobState = N'queued' AND PrinterId = @Id ORDER BY Sequence;
    ELSE IF @Mode = N'summaries'
        SELECT JSON_MODIFY(Value, '$.zpl', NULL) AS Value FROM barista.Records WHERE Kind = N'job' ORDER BY Sequence DESC;
    ELSE IF @Mode = N'summary'
        SELECT JSON_MODIFY(Value, '$.zpl', NULL) AS Value FROM barista.Records WHERE Kind = N'job' AND Id = @Id;
    ELSE IF @Mode = N'state'
        SELECT Value FROM barista.Records WHERE Kind = N'job' AND JobState = @Id;
    ELSE IF @Mode = N'printers'
        SELECT DISTINCT PrinterId AS Id FROM barista.Records WHERE Kind = N'job' AND JobState = N'queued';
    ELSE THROW 51000, 'Invalid queue operation.', 1;
END;
GO
IF OBJECT_ID(N'barista.AssetGet', N'P') IS NULL EXEC(N'CREATE PROCEDURE barista.AssetGet AS RETURN 0');
GO
ALTER PROCEDURE barista.AssetGet @Id nvarchar(150)
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS ON;
    SET ANSI_PADDING ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;
    SET XACT_ABORT ON;
    SELECT Bytes FROM barista.AssetBlobs WHERE Id = @Id;
END;
GO
IF OBJECT_ID(N'barista.AssetPut', N'P') IS NULL EXEC(N'CREATE PROCEDURE barista.AssetPut AS RETURN 0');
GO
ALTER PROCEDURE barista.AssetPut @Id nvarchar(150), @Bytes varbinary(max)
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS ON;
    SET ANSI_PADDING ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;
    SET XACT_ABORT ON;
    UPDATE barista.AssetBlobs WITH (UPDLOCK, SERIALIZABLE) SET Bytes = @Bytes WHERE Id = @Id;
    IF @@ROWCOUNT = 0 INSERT barista.AssetBlobs(Id, Bytes) VALUES (@Id, @Bytes);
END;
GO
IF OBJECT_ID(N'barista.MigrationSnapshot', N'P') IS NULL EXEC(N'CREATE PROCEDURE barista.MigrationSnapshot AS RETURN 0');
GO
ALTER PROCEDURE barista.MigrationSnapshot
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS ON;
    SET ANSI_PADDING ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;
    SET XACT_ABORT ON;
    SELECT Kind, Id, Value, Sequence FROM barista.Records ORDER BY Sequence;
    SELECT ProjectId, Revision, Value FROM barista.ProjectRevisions ORDER BY ProjectId, Revision;
    SELECT Id, Bytes FROM barista.AssetBlobs ORDER BY Id;
END;
GO
IF OBJECT_ID(N'barista.MigrationRecord', N'P') IS NULL EXEC(N'CREATE PROCEDURE barista.MigrationRecord AS RETURN 0');
GO
ALTER PROCEDURE barista.MigrationRecord @Kind nvarchar(64), @Id nvarchar(320), @Value nvarchar(max), @Sequence bigint
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS ON;
    SET ANSI_PADDING ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;
    SET XACT_ABORT ON;
    IF @@TRANCOUNT = 0 THROW 51000, 'An application transaction is required.', 1;
    SET IDENTITY_INSERT barista.Records ON;
    BEGIN TRY
        INSERT barista.Records(Kind, Id, Value, Sequence) VALUES (@Kind, @Id, @Value, @Sequence);
        SET IDENTITY_INSERT barista.Records OFF;
    END TRY
    BEGIN CATCH
        SET IDENTITY_INSERT barista.Records OFF;
        THROW;
    END CATCH;
END;
GO
IF OBJECT_ID(N'barista.MigrationRevision', N'P') IS NULL EXEC(N'CREATE PROCEDURE barista.MigrationRevision AS RETURN 0');
GO
ALTER PROCEDURE barista.MigrationRevision @ProjectId nvarchar(320), @Revision int, @Value nvarchar(max)
AS
BEGIN
    SET NOCOUNT ON;
    SET ANSI_WARNINGS ON;
    SET ANSI_PADDING ON;
    SET ARITHABORT ON;
    SET CONCAT_NULL_YIELDS_NULL ON;
    SET NUMERIC_ROUNDABORT OFF;
    SET XACT_ABORT ON;
    INSERT barista.ProjectRevisions(ProjectId, Revision, Value) VALUES (@ProjectId, @Revision, @Value);
END;
GO
