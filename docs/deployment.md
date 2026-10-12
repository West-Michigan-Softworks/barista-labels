# Deployment

## Microsoft Entra

The SPA uses client `774e41ac-9031-462b-a929-fb4d753272e5` in tenant `80f4c95f-5fab-4fe3-ad0a-e893122b4182`. These are public IDs.

Create a separate single-tenant API registration with v2 access tokens. Expose delegated scope `Labels.Access`; define user/group app roles `Labels.User` and `Labels.Admin`. Assign roles and grant the SPA permission to this API. Add a SPA redirect URI matching the exact app HTTPS origin (development:`http://localhost:5173`).

`Labels.User` grants the Printer workspace. `Labels.Admin` grants the Editor, publishing, printer configuration and connection checks, with an optional switch to Printer. Loopback development authentication includes both roles.

```dotenv
ENTRA_TENANT_ID=80f4c95f-5fab-4fe3-ad0a-e893122b4182
ENTRA_CLIENT_ID=774e41ac-9031-462b-a929-fb4d753272e5
ENTRA_API_AUDIENCE=<API client ID expected in the v2 aud claim>
ENTRA_API_SCOPE=api://<API client ID>/Labels.Access
ENTRA_REQUIRED_SCOPE=Labels.Access
BARISTA_DEV_AUTH=false
BARISTA_HOST=127.0.0.1
PORT=3001
BARISTA_DATA_DIR=./data
```

The API validates signature, issuer, audience, tenant, expiry, scope and roles. Use an access token for this API, not Graph or an ID token. `/api/me` supplies verified roles to the UI. No secret belongs in the SPA. Real SSO validation awaits the API registration and assignments.

## LAN service

Application storage defaults to SQLite. For SQL Server provisioning, environment
settings, offline migration, and backups, see [SQL storage](sql-storage.md).

Use a dedicated Node24 service account with a persistent writable data directory. Install dependencies/pinned Chromium, build, then `npm start`. Put the same-origin app/API behind an HTTPS reverse proxy. Keep development authentication disabled and limit access to the intended LAN.

Windows rendering uses installed Arial/Courier New/Times New Roman files without distributing them. Linux requires Liberation fonts at `/usr/share/fonts/truetype/liberation2` and Playwright's browser OS dependencies. Missing fonts/glyphs fail explicitly. Administrators may upload TTF/OTF files and attach them to projects.

Chromium cache defaults to `.cache/ms-playwright`; `PLAYWRIGHT_BROWSERS_PATH` overrides it. Keep browser revision and package lock together. In SQLite mode, back up the database and assets consistently, preferably with the service stopped. In SQL Server mode, a database backup includes both records and assets. Interrupted `sending` jobs become `outcome-unknown` on restart and are never automatically resent.

## Printers

Users assigned `Labels.Admin` configure host/IP, TCP9100, actual resolution, printable width, location, media and calibrated offsets. The common ZT411203dpi profile uses8dots/mm and832dots maximum width. No physical test endpoint has been supplied. Connection checks do not print. SQL catalog rows remain read-only.

Before release, compare reference fixtures, print on a designated test endpoint, measure calibrated placement within one dot and scan barcodes. `Sent` means transmission, not physical completion. Reprint is explicit; unresolved imports cannot print.
