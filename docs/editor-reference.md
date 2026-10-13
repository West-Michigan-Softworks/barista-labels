# Editor reference

Inspected installed BarTender Designer12.1 on2026-10-12 using the computer-use skill. Captured the initial1504×824px workspace and accessibility tree. After physical Escape, Computer Use remained stopped despite reset and user-authorized resumption; further interactions did not succeed. Controlled COM fixture research continued separately. Complete interactive UI parity is not claimed.

Observed: thin title/menu rows; Main toolbar New/Open/Save/Page Setup/Database Setup/Print/Preview then clipboard/history; Object toolbar Select/barcode/text/line/shape/picture; View zoom/snap/grid; second row font/size/style/alignment and line formatting; blue workspace; far-right Arrange rail for edges/centres/distribution/rotation.

Source: installed help toolbar topics and retained `BarTend.il` handlers `FormatView.OnFilePrintFromMenu`, `OnFilePrintFromToolBar`, `OnExportPrinterTemplate`; captured accessibility tree names the controls. These are interface observations, not copied code.

The app preserves compact toolbar groups, blue workspace, rulers, template tabs, object toolbox, named-field tree, right Arrange rail and desktop-style dialogs. A persistent property inspector adapts modal editing to the browser. DaisyUI components/lucide icons are independently assembled; proprietary logos/artwork are not shipped.

Keyboard:Ctrl/Cmd+S save,O open,N new,P preview/print,Z/Y undo/redo,C/X/V clipboard,A select all,D duplicate; arrows nudge0.1mm,Shift+arrows1mm. Space+drag pans; ruler dragging creates guides; double-click removes a guide; Shift-click changes selection.

Responsive artwork is provisional during editing. A debounced local render replaces it with authoritative printer-dot pixels behind editable hitboxes. Explicit preview validates content and shows the exact compilation sent/downloaded.

`tools/ui-smoke.mjs` exercises editing, Save/Open, page setup and authoritative preview at1500×900px, writing ignored screenshots. Further successful reference workflow captures remain an acceptance gate. Advanced databases/scripts/RFID/counters are outside v1.

The application-side [editor interaction audit](editor-audit.md), verified on 2026-10-13, covers every editor control site and its dialogs with asserted browser outcomes, including canvas gestures and keyboard behavior. This verifies the implemented application behavior; the reference workflow/parity acceptance gate above remains separate.
