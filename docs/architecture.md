# Architecture

The browser owns editing/history and draft recovery. `shared/model.ts` validates physical-unit projects. Node owns authentication, SQLite revisions, assets, compilation and network jobs. There is no runtime dependency on BarTender.

Rendering quantizes micrometres once, resolves data, validates fonts/glyphs/barcodes/bounds and rasterizes locally in pinned Chromium/Sharp. Native shapes are emitted only when every dot agrees. Overlapping/rotated objects retain composite order. Rendering concurrency is bounded. `/api/render` is ephemeral; `/api/compile` persists immutable snapshots.

## API contracts

All routes except `/api/config` require authentication.

- `GET /api/config`, `/api/me`:SPA config and verified roles.
- `GET/POST /api/projects`, `GET/PUT /api/projects/:id`:admin-only shared projects; updates include expected revision or receive409.
- `GET /api/projects/:id/revisions`, `/export`, `POST /api/projects/import {base64}`:history and portableZIP.
- `GET/POST /api/assets`, `GET /api/assets/:id/data`:admin-only metadata/upload/inline images.
- `POST /api/import/btw {filename,base64}`, `GET /api/import/:id`:async inspection/conversion, diagnostics and retained original.
- `GET /api/printers`:shared printer catalog. `POST /api/printers`, `PUT/DELETE /api/printers/:id`, `POST /api/printers/:id/check`:require `Labels.Admin` for configuration/connect-only checks.
- `POST /api/render` or `/api/compile {project|projectId,templateId,data,printer|printerId,quantity}`:admin-only authoritative preview/validation; compile also returnsID/ZPL.
- `GET /api/compilations/:id/zpl`, `POST /api/jobs {compilationId,idempotencyKey}`, `GET /api/jobs`, `POST /api/jobs/:id/cancel`:download anddurable queue.

Print submissions reference compiled snapshots rather than arbitrary ZPL/hosts. Printer configuration must still match. Per-printer serialization prevents interleaving; different printers run concurrently. Cancel only unsent jobs; interrupted sending requires explicit reprint.

## Published-label printing

Admins land at `/editor`; users land at `/printer`. The admin mode switch retains the mounted editor and its draft while suspending editor keyboard commands and preview rendering. Permissions are enforced independently by the API. Existing arbitrary-compilation job/batch submission endpoints are admin-only. Job lists are owner-filtered; compilation downloads, preparation previews and batch status require ownership or Admin.

- `GET /api/publications`:admin publication status, including unpublished entries.
- `POST /api/projects/:id/labels/:templateId/publish {revision}`:publish or republish a saved revision. Stable catalog identity, increasing version, immutable snapshot of one label and its required data sources/assets.
- `POST /api/publications/:id/unpublish {}`:withdraw from the catalog and block new submissions. Project deletion also withdraws its publications.
- `GET /api/published-labels`, `GET /api/published-labels/:id`:published catalog and metadata, without editor documents.
- `GET /api/published-labels/:id/csv`:headers-only UTF-8 CSV for required input fields.
- `POST /api/printer/preparations {publicationId,version,printerId,location,csv? ,quantity?}`:location is an integer or null for unassigned printers. Variable labels require CSV and prohibit quantity. Static labels prohibit CSV and accept quantity 1–10,000. Compiles every row before retaining a user-owned preparation; failed preparations do not queue jobs.
- `GET /api/printer/preparations/:id/previews?offset=0&limit=1`:pages of the exact compiled previews; limit is 1–20.
- `POST /api/printer/submissions {preparationId,idempotencyKey}`:revalidate publication version and printer snapshot, then atomically enqueue. Committed retries return the original batch; a changed request with the same key receives 409.
- `POST /api/printer/jobs/:id/reprint {idempotencyKey}`:explicit reprint of an owned job; published jobs require their version to remain published.

CSV headers must match required fields exactly, in any order. Duplicate/missing/extra headers, malformed records, blank required cells, values above 10,000 characters and more than 5,000 nonempty rows are rejected. Whitespace-only rows are ignored; leading zeros and quoted values/newlines are preserved. Each accepted CSV row prints one label. Formula-backed sources retain their dependencies in the snapshot; only their required input fields appear in CSV.

Users select a location before a printer; printer options are filtered by the integer catalog location. Unassigned printers have a separate option. A location change clears the selected printer and preparation. Server preparation validates location membership; later printer/location changes invalidate submission through the existing snapshot comparison.

Publication/version and preparation records use the existing SQLite records store. Draft saves never change published snapshots. Publication assets and historical snapshots are retained; no asset garbage collection or automatic publication migration is performed. Already queued jobs retain their compiled data when a publication is replaced or withdrawn.

Portable projects contain manifest/assets and are bounded before decompression. BTW envelope readability is separate from tested editable support; unresolved essential content blocks printing.
