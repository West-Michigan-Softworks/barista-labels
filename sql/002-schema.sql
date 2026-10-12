-- SSMS: enable SQLCMD Mode; match BARISTA_SQL_DATABASE.
:setvar BaristaDatabase "Barista"
:on error exit
USE [$(BaristaDatabase)];
GO
SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;
IF CONVERT(int, SERVERPROPERTY('ProductMajorVersion')) < 13
    THROW 51000, 'Barista requires SQL Server 2016 or later.', 1;
IF (SELECT compatibility_level FROM sys.databases WHERE database_id = DB_ID()) < 130
    THROW 51000, 'Set database compatibility level to at least 130 before installing Barista.', 1;
IF SCHEMA_ID(N'barista') IS NULL EXEC(N'CREATE SCHEMA barista AUTHORIZATION dbo');
IF OBJECT_ID(N'barista.SchemaVersion', N'U') IS NULL
BEGIN
    CREATE TABLE barista.SchemaVersion (
        Id int NOT NULL CONSTRAINT PK_BaristaSchemaVersion PRIMARY KEY CONSTRAINT CK_BaristaSchemaId CHECK (Id = 1),
        Version int NOT NULL
    );
    INSERT barista.SchemaVersion VALUES (1, 1);
END;
IF NOT EXISTS (SELECT 1 FROM barista.SchemaVersion WHERE Id = 1 AND Version = 1)
    THROW 51000, 'Unsupported Barista schema version; use the matching upgrade scripts.', 1;
IF OBJECT_ID(N'barista.Records', N'U') IS NULL
    CREATE TABLE barista.Records (
        Kind nvarchar(64) COLLATE Latin1_General_100_BIN2 NOT NULL,
        Id nvarchar(320) COLLATE Latin1_General_100_BIN2 NOT NULL,
        Value nvarchar(max) NOT NULL CONSTRAINT CK_BaristaRecordJson CHECK (ISJSON(Value) = 1),
        Sequence bigint IDENTITY(1,1) NOT NULL,
        JobState AS CONVERT(nvarchar(32), JSON_VALUE(Value, '$.state')),
        PrinterId AS CONVERT(nvarchar(320), JSON_VALUE(Value, '$.printer.id')) COLLATE Latin1_General_100_BIN2,
        CONSTRAINT PK_BaristaRecords PRIMARY KEY (Kind, Id),
        CONSTRAINT UQ_BaristaRecordSequence UNIQUE (Sequence)
    );
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'barista.Records') AND name = N'IX_BaristaQueue')
    CREATE INDEX IX_BaristaQueue ON barista.Records(JobState, PrinterId, Sequence) WHERE Kind = N'job';
IF OBJECT_ID(N'barista.ProjectRevisions', N'U') IS NULL
    CREATE TABLE barista.ProjectRevisions (
        ProjectId nvarchar(320) COLLATE Latin1_General_100_BIN2 NOT NULL,
        Revision int NOT NULL CONSTRAINT CK_BaristaRevision CHECK (Revision > 0),
        Value nvarchar(max) NOT NULL CONSTRAINT CK_BaristaRevisionJson CHECK (ISJSON(Value) = 1),
        CONSTRAINT PK_BaristaRevisions PRIMARY KEY (ProjectId, Revision)
    );
IF OBJECT_ID(N'barista.AssetBlobs', N'U') IS NULL
    CREATE TABLE barista.AssetBlobs (
        Id nvarchar(150) COLLATE Latin1_General_100_BIN2 NOT NULL CONSTRAINT PK_BaristaAssets PRIMARY KEY,
        Bytes varbinary(max) NOT NULL
    );
GO
