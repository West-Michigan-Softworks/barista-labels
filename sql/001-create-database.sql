-- SSMS: Query > SQLCMD Mode. Set this name in every script and BARISTA_SQL_DATABASE.
:setvar BaristaDatabase "Barista"
:on error exit
USE [master];
GO
DECLARE @name sysname = N'$(BaristaDatabase)';
IF DB_ID(@name) IS NULL
BEGIN
    DECLARE @statement nvarchar(max) = N'CREATE DATABASE ' + QUOTENAME(@name);
    EXEC sys.sp_executesql @statement;
END;
GO
