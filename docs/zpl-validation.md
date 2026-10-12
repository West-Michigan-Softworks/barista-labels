# ZPL validation evidence

## Current result

The standalone compiler's binary preview agrees dot-for-dot with the reconstructed emitted `^GFA` raster and isolated native `^GB` box in automated tests. Tests cover 8/12/24 dots/mm geometry, graphics field chunking, stacking, Unicode/glyph validation, field substitution, ZPL metacharacters, all seven barcode families, and quantity validation. This establishes compiler consistency, not parity with BarTender or physical printer behavior.

`tools/generate-render-fixtures.ts` produces an original, public-safe 4 × 2 inch text/Code 128/box/line label at 8, 12, and 24 dots/mm. The source document, exact printer profiles, binary preview PNGs, and emitted ZPL are saved under `research-artifacts/zpl/standalone`. These snapshots are application output, not BarTender output. One-dimensional barcode module width is chosen from available width and then its bar height is fitted at that integer scale; modules are never stretched independently.

## BarTender reference dependency

On 2026-10-12, an authorized read of `Get-PrinterDriver` and `Get-Printer` established that this machine has **no Zebra or ZDesigner ZPL printer driver or queue**. Installed drivers are Microsoft class/virtual/fax/remote-desktop drivers and Xerox PostScript drivers. Existing queues are OneNote, Microsoft Print to PDF, a Xerox queue, and Fax. Those drivers cannot establish the requested ZT411 ZPL reference output.

The exact missing dependency is an existing Zebra ZPL Windows printer queue with its installed Zebra/Seagull ZPL driver. A physical printer IP is unnecessary for Print to File, but is required later for physical acceptance testing. No drivers were installed, printer configurations changed, or actual print jobs transmitted for this investigation.

`tools/zpl-reference.ps1` records a reproducible inventory and skips all printing when that dependency is absent. When it exists, the script creates an original blank 4 × 2 inch document, explicitly sets and verifies `PrintToFile=true` and an absolute output filename under `research-artifacts/zpl` **before** calling COM `Print`. It never calls a print-to-port template export. The blank fixture validates the export path only; meaningful text, barcode, image, rotation, and overlap reference fixtures are still required after the driver becomes available.

## Reference call evidence

- Installed `Interop.BarTender.dll`, reflected `IBtFormat`: `Printer`, `PrintToFile`, `PrinterFile`, and `Print(string, bool, int, out Messages)` provide the controlled offline route.
- Installed `Interop.BarTender.dll`, reflected `IBtPrinterCodeTemplate.Export`: `Export(string printSystem, BtPctExportType, string formatOrCombinedPath, string dataPath, ref object messages)`. Export types include separate, combined, and to-port. The to-port variant is excluded from research.
- `bartender-investigation/PrintSDK.il:75522` shows the SDK forwarding template export to COM `IBtPrinterCodeTemplate.Export`.
- `bartender-investigation/help/HIDD_EXPORT_PTF.htm:147` documents printer/driver-dependent object methods and fallback.
- `bartender-investigation/help/HIDD_PCT_PRINT_SYSTEMS.htm:128` documents filtering template print systems by printer language/manufacturer. A template print-system name is not a substitute for an installed ZPL printer/driver.

These are static/reflection/documentation observations; no BarTender-generated ZPL comparison is claimed yet.

## Independent implementation references

- Zebra [`^GF`](https://docs.zebra.com/content/tcm/us/en/printers/software/zpl-pg/zpl-commands/%5Egf.html): hexadecimal bytes, bytes per row, field byte counts. The implementation splits graphics at 99,999 bytes and pads each scanline with white bits.
- Zebra [`^GB`](https://docs.zebra.com/content/tcm/us/en/printers/software/zpl-pg/zpl-commands/%5Egb.html): dimensions, border thickness, and black/no-rounding parameters. Native boxes/lines are used only when isolated, axis-aligned, and verified against the authoritative raster.
- Zebra [`^MN`](https://docs.zebra.com/us/en/printers/software/zpl-pg/zpl-commands/%5Emn.html): continuous (`N`), web/gap (`Y`), and mark (`M`) media.
- Microsoft [OpenType cmap](https://learn.microsoft.com/en-us/typography/opentype/spec/cmap): independently implemented formats 4/12 coverage check, preventing silent replacement of missing characters with OS fallback glyphs.

No proprietary code or visual assets were copied into the renderer.

Horizontal line thickness comes from `strokeUm`, not the stored selection-box height: a 100 µm box with a 400 µm stroke renders three complete rows at 8 dots/mm. Zero-stroke unfilled rectangles/ellipses produce no ink; a zero-dot line is rejected explicitly. Text may carry an explicit physical `lineHeightUm`, allowing verified imported single-line Arial metrics to retain their original bounding boxes rather than being silently enlarged. Authored text retains its default 1.15 line-height ratio.

## Controlled BTW thumbnail comparison

`tools/compare-btw-render.ts` imported the strict `mail-core.btw` text/rectangle profile and compared its authoritative output with the embedded BarTender preview. Artifacts and measured bounds are under `research-artifacts/zpl/btw-core-comparison`. The reference is cropped to its label area before resampling; this is **thumbnail evidence**, not printer-resolution reference ZPL.

| Resolution | Text ink bounds, reference → application | Box ink bounds, reference → application |
| --- | --- | --- |
| 8 dots/mm | `(123,209)-(284,232)` → `(122,209)-(284,233)` | `(406,49)-(610,152)` → `(406,51)-(608,152)` |
| 12 dots/mm | `(183,315)-(426,350)` → `(183,314)-(426,350)` | `(608,76)-(915,231)` → `(610,76)-(914,227)` |

This initial thumbnail comparison identified a box-stroke difference and motivated the full-resolution experiment below. Text placement and extent agreed within one resampled dot; the original box edges differed by up to four. These initial measurements preceded the verified centered-stroke import normalization. Label stock outlines and rounded corners in the embedded preview are presentation chrome and are excluded from label content.

Imported literal data is explicitly marked `dataMode: literal`: brace sequences remain printed text instead of acquiring unintended template bindings. Authored/template data retains field substitution and missing-field errors.

## Full-resolution BarTender image export

`tools/btw-render-reference.ps1` used installed COM `IBtFormat.ExportToFile` to export the controlled original text/rectangle fixture as **1-bit PNG** at explicitly requested 203 and 300 dpi. Files are exactly 812 × 406 and 1200 × 600 pixels with matching PNG density metadata. BarTender reports version 12.1.1. This operation needs no Zebra driver and invokes neither Print nor template export. The SDK call route is visible at `bartender-investigation/PrintSDK.il:67246`; arbitrary positive DPI is passed through the `BtResolution` enum cast, as the SDK does with calculated integer DPI.

`tools/compare-btw-full-render.ts` compiles at those exact resolutions (`203/25.4` and `300/25.4` dots/mm), without resampling. The independent raster comparison established that **BarTender centers the rectangle pen on its logical path**, while the application uses inside-stroke outer bounds. The strict BTW importer now maps that verified source geometry to outer bounds by subtracting half the physical stroke from x/y and adding the full stroke to width/height. Its warning explicitly explains the resulting property dimensions; authored rectangle semantics remain unchanged.

| Resolution | BarTender box ink bounds | Imported application ink bounds | Box-region differing pixels |
| --- | --- | --- | --- |
| 203 dpi | `(405,50)-(610,153)` | `(405,50)-(609,153)` | 204 |
| 300 dpi | `(599,74)-(901,226)` | `(599,74)-(901,226)` | **0** |

At 300 dpi the imported rectangle raster is exactly equal to the reference across its full region. At 203 dpi its right edge differs by one dot and the reference has dithered edge pixels; all other outer edges agree. Text ink bounds are exactly equal at 300 dpi and within one dot at 203 dpi. This supports the controlled-profile mapping but does **not** establish byte-identical glyph rasters, ZPL-driver parity, or physical printing accuracy. Final one-dot placement and barcode acceptance remain gated on the designated printer and reference ZPL.

## Remaining acceptance procedure

1. With an existing ZPL queue, save original reference labels and capture offline BarTender ZPL with its version, driver version, resolution, and media settings.
2. Compare label dimensions, origin, rotation, barcode module/quiet-zone dimensions, text/fonts, images, escaping, and quantities to application compilation at the same resolution. Equivalent output is required; command streams need not be identical.
3. Keep raster and native differences documented and retain unresolved mismatches as release blockers.
4. Only after a designated test endpoint is supplied, print both reference and application fixtures on the ZT411, measure calibrated placement within one dot, check clipping, and scan barcode payloads. “TCP sent” is not evidence of physical success.
