# SQL printer catalog

Enable `SQL_PRINTERS_ENABLED=true` on the Node server to populate the printer selector from **BYAPPS / LabelPrint / dbo.printersZPL**. Provide `SQL_PRINTERS_USER` and `SQL_PRINTERS_PASSWORD` through the server environment or its local ignored `.env`. Use a database login granted only SELECT on this table. Nothing creates, updates, or deletes SQL rows.

The fixed query reads `printer_id`, `name`, `location`, `description`, `brand`, `ip`, and `date_added`. Catalog identifiers are stable `sql:<printer_id>` values. Valid IPv4 addresses become TCP hosts. Invalid names, identifiers, duplicate identifiers, or addresses are excluded and reported by `/api/printers/diagnostics`; `/api/printers` remains an array and supplies an `X-Printer-Catalog-Warnings` count.

The list cache expires after three seconds. Compilation and enqueue resolve current catalog data without accepting a stale list cache. Immediately before each transmission the queue resolves the printer again and compares it with the immutable snapshot. A deleted printer, invalid address, changed endpoint/profile, or unavailable SQL server blocks transmission. A configured database outage returns 503; the application does not silently substitute local profiles or cached addresses.

SQL printer rows are read-only in the application. Local administrator profile operations do not modify SQL. Disabling SQL catalog mode selects the existing local-profile library.

This table does **not** establish each printer's resolution, width, orientation, media, offsets, or verified ZPL capabilities. The deployment defaults are 8 dots/mm, 832 dots wide, gap media, zero offsets, and TCP 9100. They are an **unverified 203-dpi ZT411 profile**, not a discovery of the device capabilities. Set `SQL_PRINTERS_DOTS_PER_MM`, `SQL_PRINTERS_WIDTH_DOTS`, and `SQL_PRINTERS_ZPL_PORT` to the tested fleet settings. `brand` is informational; the table's ZPL catalog contract is the only language assumption. Mixed-resolution fleets require a richer catalog/profile configuration before production use.

The default `mssql` driver uses SQL authentication over TCP and TLS. `SQL_PRINTERS_ENCRYPT=true` and `SQL_PRINTERS_TRUST_SERVER_CERTIFICATE=false` are defaults; provision a trusted server certificate. Only explicitly use certificate trust override for an approved internal certificate arrangement. Windows integrated authentication is not enabled by these SQL-login settings. See the primary [node-mssql configuration and authentication documentation](https://github.com/tediousjs/node-mssql#configuration).

Credentials are never returned by configuration endpoints and underlying SQL errors are replaced with a generic catalog-unavailable message. Automated tests inject a query function; no live SQL connection or physical printer was used during implementation.
