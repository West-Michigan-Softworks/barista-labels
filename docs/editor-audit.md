# Editor interaction audit

Verified on 2026-10-13 using the production Editor, Canvas, Workspace and Printer Configuration components in Chromium at 1500 × 900. All **131 interactive source sites** have an asserted outcome across **11 browser scenarios**, with 222 recorded runtime control variants and zero browser runtime errors. The separately built production application also passes its existing smoke test.

The audit covers the Editor and all dialogs it opens. The standalone Printer workspace and sign-in screen are outside this pass; editor mode switching is included. Source-site counts include repeated controls generated from arrays, such as object rows, menu entries, geometry inputs and insert tools. They do not mean there are 131 buttons simultaneously visible.

## Inventory and expected outcomes

[editor-controls.json](editor-controls.json) lists every source site with its stable ID, label, event handlers and conditional/read-only status. IDs are attached to rendered controls; the canvas has one ID representing its gesture surface. The browser suite fails if any listed site lacks a verified outcome or if a rendered interactive element lacks an inventory ID. The unit inventory check detects source additions/removals and handler-less buttons.

| Control IDs | Expected and verified outcome |
| --- | --- |
| App-001–004 | Project/BTW, image, CSV and font pickers process a selected file; selecting the same project file again imports again. Image/font assets are retained without overwriting intervening edits. |
| App-005–010 | Rename commits with Enter and cancels with Escape; publish/republish update publication/version, unpublish removes availability, switching modes preserves the Editor, and sign-out invokes its supplied callback. |
| App-011–012, App-120 | Each menu opens, every menu command reaches its matching behavior, and outside-click/Escape dismisses the menu. Unavailable commands have disabled states and reasons. |
| App-013–026 | New/Open/Save, setup/data/print dialogs, clipboard, history, selection clearing and all six insertion types produce their expected document or dialog changes. |
| App-027–037 | Zoom updates and stops at its limits; grid/snap toggles expose their state; fonts, point size, bold, all text alignments and line thickness update applicable unlocked objects; units change displayed dimensions. |
| App-038–042 | Errors dismiss; Data Sources and named-field entries open the data dialog; object-tree selection, Shift toggling and grouping match canvas selection; double-click focuses editable properties. |
| App-043 | Canvas click/Shift selection, marquee, double-click, snapped dragging, resizing, rotation, ruler guide creation/movement/removal and Space panning change the intended document or view state. Panning leaves document geometry unchanged. |
| App-044–045 | Template tabs switch the active template and clear selection; Add Template creates an empty template with the current dimensions. |
| App-046–057 | Lock/unlock, names, all geometry fields, rotation, text/barcode source modes/content, every symbology, corner radius, thickness and shape fill update properties and survive saving. Locked properties, line height and line fill restrictions are explicit. |
| App-058–068 | All six inspector alignments, stacking, rotation, group/ungroup, deletion, both label-centering actions and both distributions change geometry/order/grouping with the required selection. |
| App-069–076 | Empty-inspector Page Setup opens; all six arrangement-rail alignments and rotation match the inspector behavior. |
| App-077–083 | Blank/example projects open; valid local drafts recover; both conflict choices preserve the appropriate content; library import and project rows open documents. Portable export/import retains object content. |
| App-084–094 | Page/Layout tabs switch; project/template names and dimensions update; orientation and width/height swap change geometry; thermal-roll rows/columns/margins remain explained read-only values; OK closes the dialog. |
| App-095–102 | Printer refresh/selection, quantities and input values invalidate stale compilations; formula values stay read-only; Generate Preview shows authoritative pixels, ZPL expands/downloads, and Print queues the shown compilation to the local fake printer. In-flight compilations are discarded when their inputs change. |
| App-103–114 | Named-field add/edit/remove, source-type changes and formula evaluation work; CSV upload/mapping/quantity/sample-row/printer controls update the batch; validation queues the expected rows and quantities. New uploads reset obsolete quantity-column selections; opening another project clears old CSV state. |
| App-115–119 | Reprint confirmation cancels or queues an explicit original-job reprint; Cancel reaches the cancellation endpoint and updates its row; revision selection restores a draft; imported-project selection opens its content; the formula catalog expands. |
| Modal-001–002 | Close buttons/backdrops dismiss dialogs; Escape closes; Tab/Shift+Tab stay inside; focus returns to the initiating control when it still exists. Space activates focused buttons. Printer Configuration prevents dismissal during its own pending operation. |
| PrinterConfiguration-001–009 | Refresh/select/new work; every endpoint, dimension, offset, location and media field updates; connection checking sends no print data; save persists; delete confirmation cancels or removes the selected printer. SQL-managed profiles remain explained read-only records. Invalid profiles show errors. |

Keyboard checks also cover Ctrl+S/N/O/P, clipboard shortcuts, Ctrl+A/D, undo/redo including Ctrl+Shift+Z, Delete/Backspace, all arrow directions, Shift-arrow nudging and Escape. The production smoke test separately covers draft-preserving navigation. Shortcuts do not take over text input fields or modal editing.

## Repairs and intentional restrictions

- Fixed **Delete Printer**: bodyless DELETE requests no longer advertise a JSON body, which Fastify rejected before reaching deletion.
- Added shared prerequisites for menu/toolbar/inspector/rail actions: empty clipboard/history, missing saved revision, selection count, locks, grouping, zoom limits and pending operations. Alignment/grouping require two unlocked objects; distribution requires three. Label centering and rotation work with one.
- Removed the inert Objects button; it is now a selected pane label. Added an explicit menu-dismiss control.
- Made property labels unambiguous, added text-alignment accessible names/toggle states, and shared modal focus trapping, Escape handling, focus restoration and visible errors.
- Protected locked objects and mixed-type formatting; made tree selection/group toggling consistent with the canvas; double-click now focuses content or the object name as appropriate.
- Fixed canvas transformer lookup for valid imported IDs containing spaces; fixed ruler-click cleanup, rotated marquee bounds/group expansion and Space handling on buttons/dialogs.
- Invalidated old print compilations after history/template/profile changes, with visible printer/preview prerequisites.
- Fixed single-column CSV warning handling, stale CSV state after document changes and obsolete quantity-column mappings after new uploads. Sample rows stay integral.
- Added collision-free named-field generation, visible invalid-name feedback and recovery that tolerates malformed draft storage. Geometry edits preserve positive dimensions and bounded template sizes.
- Merged asynchronous asset responses into the latest document so uploads preserve intervening edits; insertion and template switching are unavailable while an operation is pending.

Thermal-roll layout stays one row × one column with edge-to-edge bounds. Square labels have no distinct orientation or width/height swap. Line height follows stroke thickness, and lines have no fill area. Formatting requires applicable unlocked objects. Named formula values are calculated, SQL printer records are edited in their source system, and the default printer profile supports preview/download without a physical endpoint. These restrictions are shown through read-only/disabled states, reasons and contextual text.

## Repeatable verification

```powershell
npm run audit:editor-inventory
npm run check
npm run build
npm test
node tools/ui-smoke.mjs
npm run test:editor-ui
```

Result: typecheck/build passed; 79 tests passed, with four existing skips (three unavailable original BTW research fixtures and the unconfigured SQL integration database); production smoke passed; complete editor audit passed with all 131 sites covered.

The expanded audit uses a test-only bootstrap with a fixed administrator identity, isolated SQLite storage, uploaded synthetic files and a local fake TCP printer. It builds the production components; no test entry point ships in the production bundle. Its artifacts are written under ignored `test-results/editor-audit/`: `report.json` contains per-control successful scenarios and runtime variants; `canvas.png` records visual evidence; failures produce a screenshot, accessibility tree and partial report. A diagnostic `--from=N` run explicitly does not certify full inventory coverage.

To add a control, assign a unique audit ID, add an outcome assertion to the browser scenarios, and update the reviewed inventory with `node tools/editor-control-inventory.mjs --write`. `--annotate` can assign IDs to newly added controls; updating the inventory alone does not satisfy browser coverage.

External boundaries: SQL read-only rendering, deterministic queued-job cancellation and the BTW import-report transition use controlled API fixtures, backed by the existing backend tests. Real portable import/export, font/image uploads, compilation, publication, printer CRUD/checks and local TCP delivery run against the test backend. Sign-out verifies callback dispatch; Microsoft Entra logout itself requires a real signed-in session. Physical printer output and comparison with BarTender remain separate acceptance work.
