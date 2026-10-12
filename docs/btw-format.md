# BTW format research and importer status

This is an independent format investigation. Original implementation code was written for the envelope decoder. No proprietary source or sample label files are included in the application. BarTender is unnecessary at application runtime.

**Editable import is deliberately narrow.** The importer supports two strict archive-113002 structural profiles: an original empty document with editable dimensions, and a controlled black-on-white document containing editable literal Arial text and a rectangle. Every undecoded payload byte must match a SHA-256 structural fingerprint; unrecognized graphs return blocking `BTW_EDITABLE_RECORDS_UNSUPPORTED` and no project. Most arbitrary BTW files, including the bundled templates, are consequently rejected. A decoded thumbnail alone is never treated as an editable conversion or printable label.

## Verified corpus

Read-only inventory of `C:\Program Files\Seagull\BarTender 12.1\Templates` found 228 BTW files:

| Archive version | Files | Envelope validated |
| --- | ---: | --- |
| 111054 | 32 | yes |
| 111055 | 94 | yes |
| 112015 | 76 | yes |
| 113002 | 26 | yes |

The entire installation contains 248 case-insensitive `.btw` files, including older SDK examples outside Templates; those older versions are deliberately not supported by the envelope decoder.

An original blank 4 × 2 inch label saved through BarTender 12.1.1 Enterprise COM automation also produced archive version **113002**. Thus the archive version cannot be inferred from the installed application's marketing version. Research script: `tools/btw-com.ps1`; original result in ignored `research-artifacts/btw/blank.btw`. External COM object creation is restricted to document-event scripts, but existing object deletion, geometry/font setters and literal-source XML import work. Separate workspace copies were stripped to text/rectangle fixtures and modified one property at a time. Installed samples were never edited. No physical prints were made.

`tools/btw-inspect.py` reproduces a read-only corpus inventory. Research inventory with paths, hashes, offsets and class-name candidates is generated into ignored `research-artifacts/btw-inventory.json`. Class-name searches are exploratory only and are never used by the production importer to guess object boundaries.

## Envelope layout (observed across all 228 files)

All integer fields below are little endian unless explicitly stated otherwise. Offsets after descriptions/previews are variable.

| Offset | Encoding | Observed meaning |
| --- | --- | --- |
| file start | UTF-8/ASCII | CRLF, `Bar Tender Format File`, human-readable copyright/application/document/printer/metadata, separator line |
| end of text | byte `1A` | header terminator |
| binary +0 | u32 | archive version |
| binary +4 | u32 = 2 | number of previews |
| binary +8 | u32 = 0 | reserved/unknown |
| binary +12 | u32 | duplicate archive version |
| binary +16 | u32 = 100 | unknown revision field |
| binary +20 | u32 = 10002 | unknown marker |
| binary +24 | MFC Unicode string | human-readable description, often empty |
| after description | u32 = 0 | reserved/unknown |
| twice | u32 byte length + bytes | PNG preview, with normal PNG big-endian chunk lengths |
| after previews | bytes `00 01` | observed unprotected compressed payload flags; exact semantic names unknown |
| next | complete zlib stream | binary serialized document payload |

The description's observed MFC string prefix is `FF FE FF`, followed by a character-count byte; `FF` extends the count to u16, and `FFFF` extends it to u32. Characters are UTF-16LE, counted as code units. Nonempty descriptions explain why PNGs cannot be found using fixed header offsets.

Decompressed payload begins with the same string encoding: `BarTender`, then `idbtlf`, followed by binary document identity/settings. Payloads in the bundled corpus range from 35,581 to 1,732,460 bytes. The original blank fixture is 30,322 bytes.

For the first `113002` example examined, `Australian_Food_Label_PEAL - BW.btw`, the text terminator is at byte 1059, binary header at 1060, description at 1084, first PNG at 1096 (36,168 bytes), second PNG at 37268 (624 bytes), flags at 37892 and zlib at 37894. Its decompressed archive is 1,230,735 bytes. These are observed offsets of that installed file, not universal offsets.

The production decoder sequentially reads these fields. It rejects mismatched version copies, unverified flags, truncation, invalid PNG chunk bounds, oversized input/previews/strings, corrupt zlib, decompression expansion above 32 MiB, trailing compressed data, and invalid decompressed identity. Limits: file 16 MiB, header 64 KiB, individual preview 8 MiB, preview area 25 million pixels, description 32,768 code units.

## Object graph and native boundaries

Evidence sources are `bartender-investigation/BarTend.il` (ILDasm output of the installed mixed-mode assembly) and read-only Capstone disassembly of the original `BarTend.exe`. Addresses below are RVAs, independent of ASLR.

| Finding | Evidence location | Confidence |
| --- | --- | --- |
| Box serialization first invokes common object serialization, then version-specific fill/stroke/corner data | IL line 449471, `BoxData.Serialize` | observed static |
| Common object serializer is embedded native code | IL line 1244788, `ObjectData.Serialize`, RVA `001D50B0` | observed static |
| Common object serializer writes five initial int32 members, several strings/booleans, version-conditioned fields, extensions and further attributes | native RVA `001D51D0` through `001D617A` | observed static; physical units/field semantics unresolved |
| `SArchive.ReadIdAndSize` reads a u16 identifier; `FFFF` terminates, otherwise reads a u32 size | IL line 1262787; native RVA `0081B400` through `0081B459` | observed static |
| Common object extension ID 1 reads a boolean; unknown extension IDs skip by size | native RVA `001D5E35` through `001D5ED3` | observed static |
| `SObject.Serialize` called before common object fields is empty in this build | native RVA `00819D80` | observed static |

**The ID/size mechanism is for extension blocks, not a universal wrapper around every object.** It is unsafe to assume all unknown classes can be skipped using that mechanism. The archive includes runtime class declarations such as `FF FF 01 00 0A 00` + ASCII `FormatData`, along with class/object reference tags, nested objects, printer state and data-entry forms. Exact reference tables and record boundaries remain unresolved.

Original blank fixture contains `BackgroundRFIDData`, `FormatData`, `BackgroundData`, `DialogData`, and `NumberFormatData` class declarations, despite containing no user label elements. String occurrence counts therefore do not establish editable object counts, supported features, or print eligibility.

Controlled fixtures establish thousandths-inch geometry for the two supported profiles below; units and anchor rules for other classes/graphs remain unresolved. Native disassembly alone does not establish rendered behavior. `tools/btw-native.py <hex-rva> [byte-count]` reproduces read-only native inspection with locally installed `capstone` and `pefile` research dependencies. No native decompiler provider was configured in the available REA environment; ordinary Capstone findings are not REA Evidence IDs.

## Remaining acceptance work

1. Extend the existing controlled fixture set to additional object classes and properties.
2. Resolve MFC archive class/reference tables and document/template/object ordering from native serializers and fixtures.
3. Verify geometry units, rotation/anchor rules, stacking, label size, text font/data, and barcode settings.
4. Implement explicit per-version parsers; unsupported essential content must return errors and block printing without disappearing.
5. Compare editable converted objects and print output to the original fixture in BarTender and designated Zebra printers.

Synthetic tests cover envelope structure, verified/unknown versions, truncation, corruption, expansion limits and fail-closed behavior. Local original-fixture tests cover actual editable conversion, one-property variants, unknown-byte rejection and stale cache/font-field rejection; they skip if the ignored original fixtures have not been generated. Physical-print validation remains pending.

## Implemented strict structural profiles

These are **document-family recognizers, not a general MFC archive parser**. They never scan for object names in production. Offsets are valid only after the entire normalized payload matches a controlled profile. Descriptors contain offsets, types and hashes, not proprietary binary payloads or code. Full-graph reverse engineering remains necessary to support ordinary user files.

### Original empty document

`original-blank-113002-v1`: 30,322 payload bytes; normalize only document GUID bytes 38–53 and label-dimension int32 fields at 7439/7443. All remaining bytes must hash to `910fcb1ac4f7a1f4868cd90f52133c7688e26debe08a0896631d9fc51fee1230`. Controlled width 4→3 inches changes 4000→3000, and height 2→1 changes 2000→1000. This establishes units of thousandths inch (25.4 micrometres each) for these fields. Imports a real empty editable template; never invents artwork from its preview.

### Controlled text and rectangle document

`controlled-text-rectangle-113002-v1`: a newly crafted 4 × 2 inch black-on-white layout, made by retaining just one text and one rectangle from a separate shipping-template copy, removing all other printable objects, and replacing the text with original `Hello world`. The source and one-property variants are generated by `tools/btw-profile-fixtures.ps1` into ignored `research-artifacts/btw/mail-core*.btw`.

Normalize the one length-prefixed UTF-16 literal at payload offset 43353 by removing that encoded field; the canonical payload is 100,923 bytes. Normalize only GUID, experimentally verified geometry/stroke/font fields and the derived caches below. All remaining bytes must hash to `9f971dab0164e3922b8f1440df3ae12eb68f3dc6c8efa8c0f62f5b6aa0f86975`.

| Canonical offset | Field | Validation |
| ---: | --- | --- |
| 38 | document identity, 16 bytes | ignored identity only |
| 41975 / 41979 | text X / Y, i32 | bounded thousandths inch |
| 43464 | LOGFONT height, i32 | -240 for 12 pt, -480 for 24 pt |
| 43556 | font points, f32 | exactly 12 or 24; Arial normal fixed by fingerprint |
| 43682 | text height, i32 | 187 for 12 pt, 371 for 24 pt |
| 43788 | derived text layout X, i32 | exactly 1868 minus text X |
| 43792 | derived text layout Y, i32 | text Y minus 138 (12 pt) or 140 (24 pt) |
| 45299 / 45303 | rectangle X / Y, i32 | bounded thousandths inch |
| 45397 / 45401 | rectangle height / width, i32 | positive bounded thousandths inch |
| 45406 | line thickness, i32 | bounded thousandths inch |

Positions use the verified right-side label origin and top-right object anchor. The rectangle's path left = label width − source X − rectangle width. For the 2-inch centered text container, canonical left = label width − source X − 2 inches. The original thumbnail confirms these positions: rectangle path left 2 inches, top 0.25 inches; text container left 0, top 1 inch. Stacking is text first, transparent black-outline rectangle second. COM returns line color `FF000000` and fill color `00FFFFFF`; the fill's zero alpha means transparent, despite white RGB components. A separate overlapping-object monochrome export confirmed that the text remains visible inside the rectangle (`research-artifacts/btw/mail-core-overlap.png`). That source file is a separate reread/resaved graph and does not itself match the strict import fingerprint.

Full monochrome BarTender `ExportToFile` at 203 and 300 dpi established that its rectangle pen is centered on that serialized path. The application renders strokes inside element bounds, so import subtracts half the stroke from x/y and adds the full stroke to width/height. This gives the same outer ink bounds; the import warning explicitly explains that rectangle dimensions include the outer stroke. The 300-dpi reference rectangle matched the application's corrected raster exactly (zero different pixels); at 203 dpi three edges matched and the right edge differed by one dot. Text ink bounds matched exactly at 300 dpi and within one dot at 203 dpi. Source rasters/comparison metrics are ignored research artifacts under `research-artifacts/zpl/btw-core-full-resolution`; see `docs/zpl-validation.md`. These comparisons validate local rendering, not actual ZPL driver or physical-printer parity.

Supported variants include text literal changes, text/rectangle positioning, rectangle dimensions and stroke, and Arial 12/24-point text. Literal import currently requires one printable ASCII line of at most 64 characters and consistent single-line reference caches. Template-variable bindings, other fonts, rotation, template/driver settings, additional objects, changed scripts, assets or form graphs fail closed. Literal braces are preserved by `dataMode: "literal"`; they are never silently interpreted as application variables. Imported `lineHeightUm` records the verified natural reference leading. The profile imports a fixed current literal; it does not recreate the original non-printing data-entry forms. That limitation is surfaced as an import warning.

The reference's selected printer driver and form/settings graph are intentionally fingerprinted rather than understood field-by-field. This sharply limits compatibility but prevents unsupported settings from being silently interpreted. `tools/btw-profile-analyze.py`, `tools/btw-diff.py` and `tools/btw-common.py` reproduce differential observations; they are research tools and do not select objects during import.

The unmodified 228 bundled templates all remain unsupported as editable graphs. Envelope support for versions 111054/111055/112015 does not imply object-import support for those versions. Even successfully imported profiles still require normal compilation diagnostics, font availability and deployment-printer validation before actual printing.

## Additional researched classes, still unsupported

`tools/btw-qr.ps1` created a separate QR fixture using the original literal `BARISTA-QR-01` and exported its raster locally. That object includes a human-readable caption below the QR, and its archive has a shared named-source transform. QR error-correction/module sizing, caption typography, and that transform need explicit mapping before an editable barcode import can preserve its behavior. No QR structural profile was added.

`tools/btw-image.ps1` replaced a picture only in a separate research copy with an original procedural 16 × 16 checker image, and saved a moved-object variant. Bitmap encoding, embedding/path rules and remaining picture settings have not been mapped sufficiently to extract an editable asset safely. No image structural profile was added. These files remain useful original research fixtures, not shipped artwork or conversion-support claims.
