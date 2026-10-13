import { evaluateFormula, resolveFormulaSources, formulaFunctions } from "../shared/formula";
import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useId, useRef, useState, type ReactNode, type ReactElement } from "react";
import {
  FilePlus2,
  FolderOpen,
  Save,
  Printer,
  ScanEye,
  Undo2,
  Redo2,
  Scissors,
  Copy,
  ClipboardPaste,
  MousePointer2,
  Type,
  Barcode,
  ImagePlus,
  RectangleHorizontal,
  RectangleVertical,
  Ellipsis,
  Minus,
  Grid3X3,
  Magnet,
  ZoomIn,
  ZoomOut,
  Settings2,
  AlignStartVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignEndHorizontal,
  AlignCenterVertical,
  AlignCenterHorizontal,
  ArrowDownToLine,
  ArrowUpToLine,
  RotateCw,
  LockKeyhole,
  Unlock,
  Group as GroupIcon,
  Ungroup,
  Database,
  ChevronDown,
  X,
  Download,
  CheckCircle2,
  AlertTriangle,
  Plus,
  Trash2,
  Layers,
  LogOut,
} from "lucide-react";
import type {
  Project,
  LabelElement,
  PrinterProfile,
  LabelTemplate,
} from "../shared/model";
import {
  demoProject,
  newProject,
  id,
  symbologies,
  zt411,
  projectSchema,
} from "../shared/model";
import Canvas from "./Canvas";
import { api, base64, download, saveBlob } from "./api";
import { arrange, transition, undo, redo, recoveredDrafts, nextFieldName, type History } from "./editor";
import Papa from "papaparse";
import { usePreview } from "./usePreview";
import PrinterConfiguration from "./PrinterConfiguration";
import type { PublishedLabel } from "../shared/publishing";
import Modal from "./Modal";
import { actionUnavailable } from "./editor-actions";

const ActionReason = createContext<(label: string) => string | undefined>(() => undefined);

const iconFor = (type: string) =>
  ({
    text: Type,
    barcode: Barcode,
    image: ImagePlus,
    rectangle: RectangleHorizontal,
    ellipse: Ellipsis,
    line: Minus,
  })[type] ?? Layers;
function Tool({
  icon: Icon,
  label,
  onClick,
  active,
  disabled = false,
  auditId,
}: {
  icon: any;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  auditId?: string;
}) {
  const reason = useContext(ActionReason)(label);
  return (
    <button
      title={reason ? `${label}: ${reason}` : label}
      aria-label={label}
      className={`tool btn btn-ghost btn-xs ${active ? "active" : ""}`}
      disabled={disabled || !!reason}
      data-editor-control={auditId}
      aria-pressed={active}
      onClick={onClick}
    >
      <Icon size={17} strokeWidth={1.7} />
    </button>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <div className="property-field">
      <label className="property-label" id={labelId} htmlFor={`${labelId}-control`}>{label}</label>
      {Children.map(children, child => {
        if (!isValidElement(child) || !["input", "select", "textarea"].includes(String(child.type))) return child;
        const control = child as ReactElement<{ id?: string; "aria-label"?: string; "aria-labelledby"?: string }>;
        return cloneElement(control, { id: control.props.id ?? `${labelId}-control`, ...(!control.props["aria-label"] ? { "aria-labelledby": labelId } : {}) });
      })}
    </div>
  );
}
type SavedProject = Project & { revision: number; updatedAt?: string };
type Compilation = {
  id: string;
  zpl: string;
  previewBase64: string;
  widthDots: number;
  heightDots: number;
  diagnostics: { severity: string; message: string }[];
};

export default function App({
  user,
  admin,
  active = true,
  onSwitchMode,
  development = false,
  onSignOut,
}: {
  user: string;
  admin: boolean;
  active?: boolean;
  onSwitchMode?: () => void;
  development?: boolean;
  onSignOut?: () => void;
}) {
  const [history, setHistory] = useState<History>(() => ({
    past: [],
    present: demoProject(),
    future: [],
  }));
  const project = history.present;
  const [nameEdit, setNameEdit] = useState<{ projectId: string; value: string } | null>(null);
  const cancelNameEdit = useRef(false);
  const [publications, setPublications] = useState<PublishedLabel[]>([]);
  const [templateId, setTemplateId] = useState(project.templates[0].id),
    [selected, setSelected] = useState<string[]>([]),
    [revision, setRevision] = useState(0),
    [savedJSON, setSavedJSON] = useState(""),
    [unit, setUnit] = useState<"mm" | "in">("mm"),
    [zoom, setZoom] = useState(1),
    [grid, setGrid] = useState(false),
    [snap, setSnap] = useState(true),
    [modal, setModal] = useState(""),
    [setupTab, setSetupTab] = useState<"page" | "layout">("page"),
    [status, setStatus] = useState("Ready"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [library, setLibrary] = useState<SavedProject[]>([]),
    [printers, setPrinters] = useState<PrinterProfile[]>([]),
    [printerWarnings, setPrinterWarnings] = useState<string[]>([]),
    [printerId, setPrinterId] = useState(zt411.id),
    [compilation, setCompilation] = useState<Compilation>(),
    [quantity, setQuantity] = useState(1),
    [values, setValues] = useState<Record<string, string>>({}),
    [jobs, setJobs] = useState<any[]>([]),
    [menu, setMenu] = useState(""),
    [assetUrls, setAssetUrls] = useState<Record<string, string>>({}),
    [importResult, setImportResult] = useState<any>(),
    [revisions, setRevisions] = useState<any[]>([]),
    [csvRows, setCsvRows] = useState<Record<string, string>[]>([]),
    [csvFields, setCsvFields] = useState<string[]>([]),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [quantityColumn, setQuantityColumn] = useState(""),
    [sampleRow, setSampleRow] = useState(0),
    [importProgress, setImportProgress] = useState(false);
  const clipboard = useRef<LabelElement[]>([]),
    file = useRef<HTMLInputElement>(null),
    imageFile = useRef<HTMLInputElement>(null),
    csvFile = useRef<HTMLInputElement>(null),
    fontFile = useRef<HTMLInputElement>(null),
    printKey = useRef(id());
  const [clipboardCount, setClipboardCount] = useState(0);
  const inFlight = useRef(false);
  const pendingBatch = useRef<
    | {
        signature: string;
        key: string;
        compilationIds: string[];
      }
    | undefined
  >(undefined);
  const compileKey = useRef("");
  const template =
      project.templates.find((t) => t.id === templateId) ??
      project.templates[0],
    picked = template.elements.filter((e) => selected.includes(e.id)),
    current = picked[0],
    dirty = JSON.stringify(project) !== savedJSON;
  const profile = printers.find((p) => p.id === printerId) ?? zt411;
  const factor = unit === "mm" ? 1000 : 25400;
  const unavailable = (label: string) => actionUnavailable(label, {
    picked, clipboardCount, past: history.past.length, future: history.future.length,
    zoom, revision, dirty, busy,
  });
  const textSelection = picked.length > 0 && picked.every(e => e.type === "text" && !e.locked);
  const strokeSelection = picked.length > 0 && picked.every(e => "strokeUm" in e && !e.locked);
  const focusProperties = () => {
    (document.getElementById("object-content") ?? document.querySelector<HTMLInputElement>('[aria-label="Object name"]'))?.focus();
  };
  const rawData = Object.fromEntries(
    project.variables.map((v) => [
      v.name,
      values[v.name] ??
        (csvRows.length && mapping[v.name]
          ? csvRows[sampleRow]?.[mapping[v.name]]
          : undefined) ??
        v.defaultValue,
    ]),
  );
  const resolvedSources = resolveFormulaSources(project.variables, rawData);
  const data = resolvedSources.values;
  const authoritativePreview = usePreview(project, template.id, rawData, profile, active);
  const publication = publications.find(p => p.projectId === project.id && p.templateId === template.id);
  useEffect(() => {
    if (!active) { setModal(""); setMenu(""); return; }
    let current = true;
    api<PublishedLabel[]>("/publications").then(result => { if (current) setPublications(result); }).catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [active, project.id, revision]);
  compileKey.current = JSON.stringify({
    project,
    templateId: template.id,
    data,
    profile,
    quantity,
  });
  // Undo/redo, template switches and refreshed profiles also invalidate compiled jobs.
  useEffect(() => setCompilation(undefined), [compileKey.current]);
  const change = (next: Project) => {
    setHistory((h) => transition(h, next));
    setCompilation(undefined);
  };
  const updateProject = (update: (present: Project) => Project) => {
    setHistory(h => transition(h, update(h.present)));
    setCompilation(undefined);
  };
  const elements = (next: LabelElement[]) =>
    change({
      ...project,
      templates: project.templates.map((t) =>
        t.id === template.id ? { ...t, elements: next } : t,
      ),
    });
  const property = (patch: Partial<LabelElement>) =>
    elements(
      template.elements.map((e) => {
        if (!selected.includes(e.id) || (e.locked && !("locked" in patch))) return e;
        // Type-specific formatting never adds text/barcode properties to other objects.
        if (["fontFamily", "fontSizeUm", "bold", "align", "text"].some(k => k in patch) && e.type !== "text") return e;
        if (["symbology", "value"].some(k => k in patch) && e.type !== "barcode") return e;
        if (["strokeUm", "fill"].some(k => k in patch) && !("strokeUm" in e)) return e;
        const safePatch = { ...patch } as Record<string, unknown>;
        for (const [key, value] of Object.entries(safePatch)) {
          if (typeof value !== "number") continue;
          if (!Number.isFinite(value)) return e;
          if (["widthUm", "heightUm", "fontSizeUm"].includes(key)) safePatch[key] = Math.max(1, Math.round(value));
          else if (["strokeUm", "cornerRadiusUm"].includes(key)) safePatch[key] = Math.max(0, Math.round(value));
        }
        const next = { ...e, ...safePatch } as LabelElement;
        if (e.type === "text" && next.type === "text") {
          if ("fontSizeUm" in patch && e.lineHeightUm)
            next.lineHeightUm = Math.max(
              1,
              Math.round((e.lineHeightUm * next.fontSizeUm) / e.fontSizeUm),
            );
          if ("fontFamily" in patch && patch.fontFamily !== e.fontFamily)
            next.lineHeightUm = undefined;
        }
        if (e.type === "line" && next.type === "line" && "strokeUm" in patch)
          next.heightUm = Math.max(100, next.strokeUm);
        return next;
      }),
    );
  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };
  const load = (p: Project & { revision?: number }) => {
    const parsed = projectSchema.parse(p);
    setHistory({ past: [], present: parsed, future: [] });
    setTemplateId(parsed.templates[0].id);
    setSelected([]);
    setRevision(p.revision ?? 0);
    setSavedJSON(p.revision ? JSON.stringify(parsed) : "");
    setValues({});
    setCsvRows([]); setCsvFields([]); setMapping({}); setQuantityColumn(""); setSampleRow(0);
    pendingBatch.current = undefined;
    setCompilation(undefined);
    setModal("");
    setStatus("Project opened");
  };
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api<PrinterProfile[]>("/printers")
        .then(async (list) => {
          const report = await api<{ diagnostics: { message: string }[] }>(
            "/printers/diagnostics",
          );
          if (active) {
            setPrinters(list);
            setPrinterWarnings(report.diagnostics.map((d) => d.message));
          }
        })
        .catch((e) => {
          if (active) {
            setPrinters([]);
            setError(e.message);
          }
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    const draft = localStorage.getItem("barista-draft");
    if (draft) {
      setStatus("A recovered draft is available in File → Recover draft");
    }
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const drafts = JSON.parse(
          localStorage.getItem("barista-drafts") ?? "{}",
        );
        drafts[project.id] = { project, revision };
        localStorage.setItem("barista-drafts", JSON.stringify(drafts));
        localStorage.setItem(
          "barista-draft",
          JSON.stringify({ project, revision }),
        );
      } catch {
        setStatus("Draft recovery storage is full; save your project");
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [project, revision]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);
  useEffect(() => {
    let cancelled = false;
    const urls: Record<string, string> = {};
    Promise.all(
      project.assets
        .filter((a) => a.kind !== "font" && a.kind !== "original")
        .map(async (a) => {
          try {
            const r = await api<{ base64?: string }>(`/assets/${a.id}/data`);
            if (r.base64) urls[a.id] = `data:${a.mimeType};base64,${r.base64}`;
          } catch {
            /* Missing assets are shown in the canvas and blocked by compiler. */
          }
        }),
    ).then(() => {
      if (!cancelled) setAssetUrls(urls);
    });
    return () => {
      cancelled = true;
    };
  }, [project.assets]);
  useEffect(() => {
    if (modal !== "jobs") return;
    const refresh = () =>
      api("/jobs")
        .then(setJobs)
        .catch((e) => setError(e.message));
    refresh();
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [modal]);
  const saveProject = async () => {
      let result: SavedProject;
      try {
        result = await api<SavedProject>(
          revision ? `/projects/${project.id}` : "/projects",
          { ...project, revision },
          revision ? "PUT" : "POST",
        );
      } catch (e) {
        if ((e as any).status === 409) setModal("conflict");
        throw e;
      }
      setRevision(result.revision);
      setSavedJSON(JSON.stringify(project));
      setStatus(`Saved · revision ${result.revision}`);
      return result;
    };
  const save = () => run(async () => { await saveProject(); });
  const publish = () => run(async () => {
    const saved = dirty || !revision ? await saveProject() : { revision };
    await api(`/projects/${project.id}/labels/${template.id}/publish`, { revision: saved.revision });
    setPublications(await api("/publications"));
    setStatus(`Published ${template.name}`);
  });
  const openLibrary = () =>
    run(async () => {
      setLibrary(await api("/projects"));
      setModal("library");
    });
  const add = (type: LabelElement["type"]) => {
    const base = {
      id: id(),
      name:
        type[0].toUpperCase() +
        type.slice(1) +
        " " +
        (template.elements.filter((e) => e.type === type).length + 1),
      xUm: 5000,
      yUm: 5000,
      widthUm: 30000,
      heightUm: 10000,
      rotation: 0,
      locked: false,
    };
    let e: LabelElement;
    if (type === "text")
      e = {
        ...base,
        type,
        text: "Text",
        fontFamily: "Arial",
        fontSizeUm: 4000,
        bold: false,
        align: "left",
      };
    else if (type === "barcode")
      e = {
        ...base,
        type,
        widthUm: 50000,
        heightUm: 18000,
        symbology: "code128",
        value: "1234567890",
      };
    else if (type === "image") {
      imageFile.current?.click();
      return;
    } else
      e = {
        ...base,
        type,
        heightUm: type === "line" ? 300 : 20000,
        strokeUm: 300,
        fill: "none",
      };
    elements([...template.elements, e]);
    setSelected([e.id]);
  };
  const remove = () => {
    if (unavailable("Delete")) return;
    elements(
      template.elements.filter((e) => !selected.includes(e.id) || e.locked),
    );
    setSelected([]);
  };
  const copy = () => {
    if (unavailable("Copy")) return;
    clipboard.current = structuredClone(picked);
    setClipboardCount(picked.length);
    setStatus(`${picked.length} object(s) copied`);
  };
  const paste = () => {
    if (!clipboard.current.length) return;
    const groups = new Map<string, string>();
    const next = clipboard.current.map((e) => ({
      ...e,
      id: id(),
      name: e.name + " copy",
      xUm: e.xUm + 2000,
      yUm: e.yUm + 2000,
      locked: false,
      groupId: e.groupId
        ? (groups.get(e.groupId) ??
          (groups.set(e.groupId, id()), groups.get(e.groupId)))
        : undefined,
    }));
    elements([...template.elements, ...next]);
    setSelected(next.map((e) => e.id));
  };
  const arrangeSelected = (action: string) =>
    elements(
      arrange(
        template.elements,
        selected,
        action,
        template.widthUm,
        template.heightUm,
      ),
    );
  const order = (front: boolean) => {
    if (unavailable(front ? "Bring to front" : "Send to back")) return;
    const movable = picked.filter(e => !e.locked);
    const rest = template.elements.filter((e) => !movable.some(p => p.id === e.id));
    elements(front ? [...rest, ...movable] : [...movable, ...rest]);
  };
  const group = (ungroup = false) =>
    !unavailable(ungroup ? "Ungroup" : "Group") && property({ groupId: ungroup ? undefined : id() });
  const compile = async () => {
    const requestedKey = compileKey.current;
    const c = await api<Compilation>("/compile", {
      project,
      templateId: template.id,
      data,
      printer: profile,
      printerId: printers.some((p) => p.id === profile.id)
        ? profile.id
        : undefined,
      quantity,
    });
    if (requestedKey !== compileKey.current) {
      setStatus("Label changed during compilation; generate the preview again");
      return;
    }
    setCompilation(c);
    printKey.current = id();
    setStatus("Print preview generated");
  };
  const preview = () => {
    setModal("print");
    run(compile);
  };
  const physicalPrint = () =>
    run(async () => {
      if (!compilation) throw new Error("Generate a preview first");
      await api("/jobs", {
        compilationId: compilation.id,
        idempotencyKey: printKey.current,
      });
      setStatus("Print job queued");
      setModal("jobs");
    });
  const importFile = (f: File) =>
    run(async () => {
      if (f.name.toLowerCase().endsWith(".btw")) {
        setImportProgress(true);
        setModal("import");
        try {
          const task = await api("/import/btw", {
            base64: await base64(f),
            filename: f.name,
          });
          let result;
          for (let n = 0; n < 120; n++) {
            result = await api(`/import/${task.id}`);
            if (result.status !== "processing") break;
            await new Promise((r) => setTimeout(r, 500));
          }
          setImportResult(result);
          if (result?.status === "failed") throw new Error(result.error);
        } finally {
          setImportProgress(false);
        }
      } else load(await api("/projects/import", { base64: await base64(f) }));
    });
  const uploadImage = (f: File) =>
    run(async () => {
      const asset = await api("/assets", {
        base64: await base64(f),
        name: f.name,
        mimeType: f.type,
        kind: "image",
      });
      const e: LabelElement = {
        id: id(),
        name: f.name,
        type: "image",
        assetId: asset.id,
        xUm: 5000,
        yUm: 5000,
        widthUm: 25000,
        heightUm: 25000,
        rotation: 0,
        locked: false,
      };
      updateProject(present => ({
        ...present,
        assets: present.assets.some((a) => a.id === asset.id)
          ? present.assets
          : [...present.assets, asset],
        templates: present.templates.map((t) =>
          t.id === template.id ? { ...t, elements: [...t.elements, e] } : t,
        ),
      }));
      setSelected([e.id]);
    });
  const loadCsv = async (f: File) => {
    if (f.size > 16 * 1024 * 1024) {
      setError("CSV exceeds the 16 MiB limit");
      return;
    }
    const result = Papa.parse<Record<string, string>>(await f.text(), {
      header: true,
      skipEmptyLines: true,
    });
    // A one-column CSV is valid; Papa defaults to comma when there is no delimiter to detect.
    const errors = result.errors.filter(error => error.code !== "UndetectableDelimiter");
    if (errors.length) {
      setError(errors[0].message);
      return;
    }
    if (result.data.length > 5000) {
      setError("A batch may contain at most 5000 rows");
      return;
    }
    setCsvRows(result.data);
    setCsvFields(result.meta.fields ?? []);
    setMapping(
      Object.fromEntries(
        project.variables.map((v) => [
          v.name,
          (result.meta.fields ?? []).includes(v.name) ? v.name : "",
        ]),
      ),
    );
    setSampleRow(0);
    setQuantityColumn("");
    setValues({});
  };
  const printBatch = () =>
    run(async () => {
      if (!printers.some((p) => p.id === profile.id))
        throw new Error("Configure a printer endpoint first");
      if (project.variables.some((v) => v.formula === undefined && !mapping[v.name]))
        throw new Error("Map each named field before printing a batch");
      const signature = JSON.stringify({
        project,
        templateId: template.id,
        csvRows,
        mapping,
        quantityColumn,
        quantity,
        profile,
      });
      if (!pendingBatch.current || pendingBatch.current.signature !== signature)
        pendingBatch.current = { signature, key: id(), compilationIds: [] };
      const batch = pendingBatch.current;
      for (let i = batch.compilationIds.length; i < csvRows.length; i++) {
        const row = csvRows[i];
        const d = Object.fromEntries(
          project.variables.filter(v => v.formula === undefined).map((v) => [v.name, row[mapping[v.name]] ?? ""]),
        );
        const q = quantityColumn ? Number(row[quantityColumn]) : quantity;
        const c = await api<Compilation>("/compile", {
          project,
          templateId: template.id,
          data: d,
          printerId: profile.id,
          quantity: q,
        });
        if (c.diagnostics.some((d) => d.severity === "error"))
          throw new Error(
            `Row ${i + 1}: ${c.diagnostics.map((d) => d.message).join("; ")}`,
          );
        batch.compilationIds.push(c.id);
        setStatus(`Validated ${i + 1}/${csvRows.length} rows`);
      }
      await api("/batches", {
        compilationIds: batch.compilationIds,
        idempotencyKey: batch.key,
      });
      pendingBatch.current = undefined;
      setStatus(`Queued ${batch.compilationIds.length} batch rows`);
      setModal("jobs");
    });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!active) return;
      if (
        /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName) ||
        modal
      )
        return;
      const ctrl = e.ctrlKey || e.metaKey;
      let handled = true;
      const keyName = e.key.toLowerCase();
      const command = ctrl ? ({ s: "Save", n: "New project", o: "Open project", p: "Print", z: e.shiftKey ? "Redo" : "Undo", y: "Redo", c: "Copy", x: "Cut", v: "Paste" } as Record<string, string>)[keyName] : ["Delete", "Backspace"].includes(e.key) ? "Delete" : undefined;
      if (command && unavailable(command)) { e.preventDefault(); return; }
      if (e.key === "Escape" && menu) { setMenu(""); e.preventDefault(); return; }
      if (ctrl && keyName === "s") void save();
      else if (ctrl && keyName === "n") setModal("new");
      else if (ctrl && keyName === "o") void openLibrary();
      else if (ctrl && keyName === "p") preview();
      else if (ctrl && keyName === "z")
        setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
      else if (ctrl && keyName === "y") setHistory(redo);
      else if (ctrl && keyName === "c") copy();
      else if (ctrl && keyName === "x") {
        copy();
        remove();
      } else if (ctrl && keyName === "v") paste();
      else if (ctrl && keyName === "a")
        setSelected(template.elements.map((e) => e.id));
      else if (ctrl && keyName === "d") {
        copy();
        paste();
      } else if (e.key === "Delete" || e.key === "Backspace") remove();
      else if (e.key === "Escape") setSelected([]);
      else if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
      ) {
        const d = e.shiftKey ? 1000 : 100;
        elements(
          template.elements.map((el) =>
            selected.includes(el.id) && !el.locked
              ? {
                  ...el,
                  xUm:
                    el.xUm +
                    (e.key === "ArrowLeft"
                      ? -d
                      : e.key === "ArrowRight"
                        ? d
                        : 0),
                  yUm:
                    el.yUm +
                    (e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0),
                }
              : el,
          ),
        );
      } else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const refreshPrinters = async () => {
    try {
      const list = await api<PrinterProfile[]>("/printers");
      const report = await api<{ diagnostics: { message: string }[] }>(
        "/printers/diagnostics",
      );
      setPrinters(list);
      setPrinterWarnings(report.diagnostics.map((d) => d.message));
    } catch (error) {
      setPrinters([]);
      throw error;
    }
  };
  const showHistory = () =>
    run(async () => {
      if (!revision)
        throw new Error("Save the project before viewing revisions");
      setRevisions(await api(`/projects/${project.id}/revisions`));
      setModal("history");
    });
  const menuItems: Record<string, [string, () => void][]> = {
    File: [
      [
        "New project",
        () => {
          setModal("new");
        },
      ],
      ["Open project library", () => void openLibrary()],
      ["Import BTW / Barista project", () => file.current?.click()],
      ["Save", () => void save()],
      [
        "Export portable project",
        () =>
          run(async () => {
            if (!revision || dirty)
              throw new Error("Save the current revision first");
            await download(
              `/projects/${project.id}/export`,
              `${project.name}.barista`,
            );
          }),
      ],
      ["Recover draft", () => setModal("drafts")],
      ["Revision history", () => void showHistory()],
      ["Page setup", () => setModal("setup")],
      ["Print preview / Print", preview],
    ],
    Edit: [
      ["Undo", () => setHistory(undo)],
      ["Redo", () => setHistory(redo)],
      [
        "Cut",
        () => {
          copy();
          remove();
        },
      ],
      ["Copy", copy],
      ["Paste", paste],
      ["Delete", remove],
      ["Select all", () => setSelected(template.elements.map((e) => e.id))],
    ],
    View: [
      ["Show grid", () => setGrid(!grid)],
      ["Snap to grid / object", () => setSnap(!snap)],
      ["Zoom in", () => setZoom(Math.min(3, zoom + 0.1))],
      ["Zoom out", () => setZoom(Math.max(0.2, zoom - 0.1))],
    ],
    Arrange: [
      ["Group", () => group()],
      ["Ungroup", () => group(true)],
      ["Bring to front", () => order(true)],
      ["Send to back", () => order(false)],
      ["Rotate 90°", () => arrangeSelected("rotate")],
    ],
    Tools: [
      ["Named fields / CSV data", () => setModal("data")],
      ["Print jobs", () => setModal("jobs")],
    ],
    Administer: [
      ...(admin ? [["Printer configuration", () => setModal("printers")] as [string, () => void]] : []),
      ["Upload font", () => fontFile.current?.click()],
    ],
  };
  return (
    <ActionReason.Provider value={unavailable}>
    <div className="application" data-theme="light">
      <input data-editor-control="App-001"
        ref={file}
        type="file"
        accept=".btw,.barista"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importFile(f);
          e.target.value = "";
        }}
      />
      <input data-editor-control="App-002"
        ref={imageFile}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void uploadImage(f);
          e.target.value = "";
        }}
      />
      <input data-editor-control="App-003"
        ref={csvFile}
        type="file"
        accept=".csv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void run(() => loadCsv(f));
          e.target.value = "";
        }}
      />
      <input data-editor-control="App-004"
        ref={fontFile}
        type="file"
        accept=".ttf,.otf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f)
            run(async () => {
              const family = prompt(
                "Font family name",
                f.name.replace(/\.[^.]+$/, ""),
              );
              if (!family) return;
              const asset = await api("/assets", {
                base64: await base64(f),
                name: family,
                mimeType: "font/ttf",
                kind: "font",
              });
              updateProject(present => ({
                ...present,
                assets: [
                  ...present.assets.filter((a) => a.id !== asset.id),
                  asset,
                ],
              }));
            });
          e.target.value = "";
        }}
      />
      <div className="titlebar">
        <div className="brand">
          <img className="brand-square" src="/branding/barista-icon-64.png" alt="" width="23" height="23" />
          <b>Barista Labels</b>
          <span className="title-divider">/</span>
          {nameEdit?.projectId === project.id ? (
            <input data-editor-control="App-005"
              className="header-name-input"
              aria-label="Label name"
              value={nameEdit.value}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setNameEdit({ projectId: project.id, value: e.target.value })}
              onBlur={() => {
                const name = nameEdit.value.trim();
                if (!cancelNameEdit.current && name && name !== project.name) {
                  change({ ...project, name });
                }
                setNameEdit(null);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" || e.key === "Escape") {
                  e.preventDefault();
                  cancelNameEdit.current = e.key === "Escape";
                  e.currentTarget.blur();
                }
              }}
            />
          ) : (
            <span data-editor-control="App-006"
              className="header-name"
              tabIndex={0}
              title="Double-click to rename label"
              onDoubleClick={() => {
                cancelNameEdit.current = false;
                setNameEdit({ projectId: project.id, value: project.name });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "F2") {
                  e.preventDefault();
                  cancelNameEdit.current = false;
                  setNameEdit({ projectId: project.id, value: project.name });
                }
              }}
            >
              {project.name}
              {dirty ? " *" : ""}
            </span>
          )}
        </div>
        <div className="title-actions">
          <span className="publication-status">{publication?.published ? `Published v${publication.version}${dirty || publication.sourceRevision !== revision ? " · draft changes" : ""}` : "Unpublished"}</span>
          <button data-editor-control="App-007" className="btn btn-sm" disabled={busy} onClick={publish}>{publication?.published ? "Republish label" : "Publish label"}</button>
          {publication?.published && <button data-editor-control="App-008" className="btn btn-sm" disabled={busy} onClick={() => run(async () => {
            await api(`/publications/${publication.id}/unpublish`, {}); setPublications(await api("/publications")); setStatus(`Unpublished ${template.name}`);
          })}>Unpublish label</button>}
          {onSwitchMode && <button data-editor-control="App-009" className="btn btn-sm" disabled={busy} onClick={onSwitchMode}>Switch to Printer</button>}
          {development && <span className="dev-tag">LOCAL DEVELOPMENT</span>}
          <span>{user}</span>
          {onSignOut && (
            <Tool auditId="App-010" icon={LogOut} label="Sign out" onClick={onSignOut} />
          )}
        </div>
      </div>
      <nav className="menubar">
        {Object.keys(menuItems)
          .filter((k) => k !== "Administer" || admin)
          .map((k) => (
            <div className="menu-container" key={k}>
              <button data-editor-control="App-011"
                className={menu === k ? "open" : ""}
                aria-expanded={menu === k}
                onClick={() => setMenu(menu === k ? "" : k)}
              >
                {k}
              </button>
              {menu === k && (
                <>
                  <button data-editor-control="App-120" className="menu-dismiss" aria-label="Dismiss menu" tabIndex={-1} onClick={() => setMenu("")} />
                  <div className="desktop-menu">
                    {menuItems[k].map(([label, action]) => (
                      <button data-editor-control="App-012"
                        key={label}
                        disabled={!!unavailable(label)}
                        title={unavailable(label)}
                        onClick={() => {
                          setMenu("");
                          action();
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        <span className="menu-right">Standalone label designer</span>
      </nav>
      <div className="toolbar main-toolbar">
        <div className="tool-group">
          <Tool auditId="App-013"
            icon={FilePlus2}
            label="New project"
            onClick={() => setModal("new")}
          />
          <Tool auditId="App-014"
            icon={FolderOpen}
            label="Open project"
            onClick={() => void openLibrary()}
          />
          <Tool auditId="App-015"
            icon={Save}
            label="Save project (Ctrl+S)"
            onClick={() => void save()}
            disabled={busy}
          />
          <Tool auditId="App-016"
            icon={Settings2}
            label="Page setup"
            onClick={() => setModal("setup")}
          />
          <Tool auditId="App-017"
            icon={Database}
            label="Named fields and CSV"
            onClick={() => setModal("data")}
          />
          <Tool auditId="App-018" icon={Printer} label="Print (Ctrl+P)" onClick={preview} />
          <Tool auditId="App-019" icon={ScanEye} label="Print preview" onClick={preview} />
        </div>
        <div className="tool-group">
          <Tool auditId="App-020"
            icon={Scissors}
            label="Cut"
            disabled={!picked.length}
            onClick={() => {
              copy();
              remove();
            }}
          />
          <Tool auditId="App-021"
            icon={Copy}
            label="Copy"
            disabled={!picked.length}
            onClick={copy}
          />
          <Tool auditId="App-022" icon={ClipboardPaste} label="Paste" onClick={paste} />
          <Tool auditId="App-023"
            icon={Undo2}
            label="Undo"
            disabled={!history.past.length}
            onClick={() => setHistory(undo)}
          />
          <Tool auditId="App-024"
            icon={Redo2}
            label="Redo"
            disabled={!history.future.length}
            onClick={() => setHistory(redo)}
          />
        </div>
        <div className="tool-group">
          <Tool auditId="App-025"
            icon={MousePointer2}
            label="Select objects"
            active
            onClick={() => setSelected([])}
          />
          {(
            [
              "barcode",
              "text",
              "line",
              "rectangle",
              "ellipse",
              "image",
            ] as const
          ).map((t) => (
            <Tool auditId="App-026"
              key={t}
              icon={iconFor(t)}
              label={`Insert ${t}`}
              onClick={() => add(t)}
            />
          ))}
        </div>
        <div className="tool-group">
          <Tool auditId="App-027"
            icon={ZoomIn}
            label="Zoom in"
            onClick={() => setZoom(Math.min(3, zoom + 0.1))}
          />
          <Tool auditId="App-028"
            icon={ZoomOut}
            label="Zoom out"
            onClick={() => setZoom(Math.max(0.2, zoom - 0.1))}
          />
          <select data-editor-control="App-029"
            aria-label="Zoom"
            className="toolbar-select"
            value={Math.round(zoom * 100)}
            onChange={(e) => setZoom(Number(e.target.value) / 100)}
          >
            {[25, 50, 75, 100, 125, 150, 200, 250, 300, Math.round(zoom * 100)]
              .filter((v, i, a) => a.indexOf(v) === i)
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n}>{n}</option>
              ))}
          </select>
          <Tool auditId="App-030"
            icon={Magnet}
            label="Snap to grid and objects"
            active={snap}
            onClick={() => setSnap(!snap)}
          />
          <Tool auditId="App-031"
            icon={Grid3X3}
            label="Show grid"
            active={grid}
            onClick={() => setGrid(!grid)}
          />
        </div>
      </div>
      <div className="toolbar format-toolbar">
        <select data-editor-control="App-032"
          aria-label="Font family"
          value={current?.type === "text" ? current.fontFamily : "Arial"}
          onChange={(e) => property({ fontFamily: e.target.value } as any)}
          disabled={!textSelection}
          title={!textSelection ? "Select unlocked text objects" : undefined}
          className="toolbar-select font-select"
        >
          {[
            "Arial",
            "Courier New",
            "Times New Roman",
            ...project.assets
              .filter((a) => a.kind === "font")
              .map((a) => a.name),
          ].map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
        <input data-editor-control="App-033"
          aria-label="Font size in points"
          className="toolbar-input"
          type="number"
          min="1"
          value={
            current?.type === "text"
              ? Math.round(current.fontSizeUm / 352.778)
              : 12
          }
          disabled={!textSelection}
          title={!textSelection ? "Select unlocked text objects" : undefined}
          onChange={(e) =>
            property({
              fontSizeUm: Math.round(Number(e.target.value) * 352.778),
            } as any)
          }
        />
        <button data-editor-control="App-034"
          aria-label="Bold"
          className={`tool bold-button ${current?.type === "text" && current.bold ? "active" : ""}`}
          disabled={!textSelection}
          aria-pressed={current?.type === "text" && current.bold}
          title={!textSelection ? "Select unlocked text objects" : undefined}
          onClick={() =>
            current?.type === "text" && property({ bold: !current.bold })
          }
        >
          B
        </button>
        <span className="toolbar-sep" />
        {(["left", "center", "right"] as const).map((a) => (
          <button data-editor-control="App-035"
            key={a}
            className={`text-align-button ${current?.type === "text" && current.align === a ? "active" : ""}`}
            title={`Text align ${a}`}
            aria-label={`Text align ${a}`}
            aria-pressed={current?.type === "text" && current.align === a}
            disabled={!textSelection}
            onClick={() => property({ align: a } as any)}
          >
            <span className={a} />
          </button>
        ))}
        <span className="toolbar-sep" />
        <span className="toolbar-label">Line:</span>
        <input data-editor-control="App-036"
          aria-label="Line thickness mm"
          className="toolbar-input"
          type="number"
          step=".1"
          min="0"
          value={
            current && "strokeUm" in current ? current.strokeUm / 1000 : 0.3
          }
          disabled={!strokeSelection}
          title={!strokeSelection ? "Select unlocked line or shape objects" : undefined}
          onChange={(e) =>
            property({
              strokeUm: Math.round(Number(e.target.value) * 1000),
            } as any)
          }
        />
        <span className="toolbar-label">mm</span>
        <span className="toolbar-sep" />
        <span className="toolbar-label">Units</span>
        <select data-editor-control="App-037"
          aria-label="Display units"
          className="toolbar-select"
          value={unit}
          onChange={(e) => setUnit(e.target.value as "mm" | "in")}
        >
          <option value="mm">mm</option>
          <option value="in">inches</option>
        </select>
        <span className="toolbar-fill" />
        <span className="toolbar-label">{profile.name}</span>
        <span className="dot-indicator" />
      </div>
      {error && (
        <div className="notice error" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
          <button data-editor-control="App-038" aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {project.importDiagnostics.some((d) => d.severity === "error") && (
        <div className="notice">
          <AlertTriangle size={15} />
          Imported content has unresolved compatibility issues. Printing is
          blocked.
        </div>
      )}
      <div className="workspace">
        <aside className="explorer">
          <div className="pane-title">
            Toolbox <ChevronDown size={13} />
          </div>
          <div className="explorer-tabs">
            <span className="selected">Objects</span>
            <button data-editor-control="App-039" onClick={() => setModal("data")}>Data Sources</button>
          </div>
          <div className="tree-heading">
            <ChevronDown size={13} />
            <Layers size={14} /> {template.name}
          </div>
          <div className="object-tree">
            {template.elements.map((e) => {
              const Icon = iconFor(e.type);
              return (
                <button data-editor-control="App-040"
                  key={e.id}
                  className={selected.includes(e.id) ? "selected" : ""}
                  onClick={(event) =>
                    setSelected(
                      (() => {
                        const peers = e.groupId ? template.elements.filter(x => x.groupId === e.groupId).map(x => x.id) : [e.id];
                        return event.shiftKey ? selected.includes(e.id) ? selected.filter(x => !peers.includes(x)) : [...new Set([...selected, ...peers])] : peers;
                      })(),
                    )
                  }
                  onDoubleClick={() =>
                    focusProperties()
                  }
                >
                  <Icon size={15} />
                  <span>{e.name}</span>
                  {e.locked && <LockKeyhole size={11} />}
                </button>
              );
            })}
            {!template.elements.length && (
              <div className="empty-tree">
                Insert an object from the toolbar to start designing.
              </div>
            )}
          </div>
          <div className="pane-title secondary">
            Named data sources{" "}
            <button data-editor-control="App-041"
              aria-label="Edit named fields"
              onClick={() => setModal("data")}
            >
              <Plus size={13} />
            </button>
          </div>
          <div className="data-tree">
            {project.variables.map((v) => (
              <button data-editor-control="App-042" key={v.name} onClick={() => setModal("data")}>
                <Database size={13} />
                {v.name}
              </button>
            ))}
            {!project.variables.length && (
              <div className="empty-tree">
                Use named fields for reusable labels.
              </div>
            )}
          </div>
          <div className="explorer-footer">
            <b>Document</b>
            <span>
              {(template.widthUm / 1000).toFixed(1)} ×{" "}
              {(template.heightUm / 1000).toFixed(1)} mm
            </span>
            <span>
              {template.elements.length} objects · {project.templates.length}{" "}
              template(s)
            </span>
          </div>
        </aside>
        <main className="design-workspace">
          <div className="document-tab">
            <span>
              <Layers size={14} />
              {project.name}
              {dirty ? " *" : ""}
            </span>
            <span className="document-tab-right">Design</span>
          </div>
          <Canvas auditId="App-043"
            template={template}
            project={project}
            selected={selected}
            onSelect={setSelected}
            onChange={elements}
            zoom={zoom}
            grid={grid}
            snap={snap}
            unit={unit}
            data={data}
            assetUrls={assetUrls}
            authoritativePreview={authoritativePreview}
            dotsPerMm={profile.dotsPerMm}
            onGuideChange={(guides) =>
              change({
                ...project,
                templates: project.templates.map((t) =>
                  t.id === template.id ? { ...t, guides } : t,
                ),
              })
            }
            onDoubleClick={() =>
              focusProperties()
            }
          />
          <div className="template-tabs">
            {project.templates.map((t) => (
              <button data-editor-control="App-044"
                key={t.id}
                disabled={busy}
                title={busy ? "Wait for the current operation to finish" : undefined}
                className={t.id === template.id ? "active" : ""}
                onClick={() => {
                  setTemplateId(t.id);
                  setSelected([]);
                  setCompilation(undefined);
                }}
              >
                {t.name}
              </button>
            ))}
            <button data-editor-control="App-045"
              aria-label="Add template"
              disabled={busy}
              title={busy ? "Wait for the current operation to finish" : undefined}
              onClick={() => {
                const t: LabelTemplate = {
                  id: id(),
                  name: `Template ${project.templates.length + 1}`,
                  widthUm: template.widthUm,
                  heightUm: template.heightUm,
                  elements: [],
                };
                change({ ...project, templates: [...project.templates, t] });
                setTemplateId(t.id);
                setSelected([]);
              }}
            >
              <Plus size={13} />
            </button>
            <span className="template-tabs-right">Template design</span>
          </div>
        </main>
        <aside className="inspector">
          <div className="pane-title">
            {picked.length > 1
              ? `${picked.length} objects selected`
              : "Object Properties"}
            <Settings2 size={13} />
          </div>
          {current ? (
            <>
              <div className="inspector-object">
                <span className="object-icon">
                  {(() => {
                    const Icon = iconFor(current.type);
                    return <Icon size={21} />;
                  })()}
                </span>
                <div>
                  <b>{current.name}</b>
                  <small>{current.type}</small>
                </div>
                <Tool auditId="App-046"
                  icon={current.locked ? LockKeyhole : Unlock}
                  label={current.locked ? "Unlock selection" : "Lock selection"}
                  onClick={() => property({ locked: !current.locked })}
                />
              </div>
              <fieldset className="editable-properties" disabled={picked.every(e => e.locked)}>
              {picked.some(e => e.locked) && <p className="property-hint">Locked objects stay unchanged. Unlock them to edit their properties.</p>}
              <section>
                <h3>General</h3>
                <Field label="Name">
                  <input data-editor-control="App-047"
                    aria-label="Object name"
                    value={current.name}
                    onChange={(e) => property({ name: e.target.value })}
                  />
                </Field>
              </section>
              <section>
                <h3>
                  Position & size <small>{unit}</small>
                </h3>
                <div className="property-grid">
                  {(["xUm", "yUm", "widthUm", "heightUm"] as const).map((k) => (
                    <Field
                      key={k}
                      label={
                        {
                          xUm: "X",
                          yUm: "Y",
                          widthUm: "Width",
                          heightUm: "Height",
                        }[k]
                      }
                    >
                      <input data-editor-control="App-048"
                        aria-label={k}
                        type="number"
                        disabled={current.type === "line" && k === "heightUm"}
                        title={current.type === "line" && k === "heightUm" ? "Line height follows stroke thickness" : undefined}
                        min={
                          k === "widthUm" || k === "heightUm"
                            ? 0.001
                            : undefined
                        }
                        step={unit === "mm" ? ".1" : ".01"}
                        value={Number((current[k] / factor).toFixed(3))}
                        onChange={(e) =>
                          property({
                            [k]: Math.round(Number(e.target.value) * factor),
                          })
                        }
                      />
                    </Field>
                  ))}
                </div>
                <Field label="Rotation">
                  <input data-editor-control="App-049"
                    type="number"
                    aria-label="Rotation"
                    value={current.rotation}
                    onChange={(e) =>
                      property({ rotation: Number(e.target.value) })
                    }
                  />
                </Field>
              </section>
              {current.type === "text" && (
                <section>
                  <h3>Text</h3>
                  <Field label="Data source">
                    <select data-editor-control="App-050"
                      aria-label="Text data source"
                      value={current.dataMode ?? "template"}
                      onChange={(e) =>
                        property({ dataMode: e.target.value } as any)
                      }
                    >
                      <option value="literal">Embedded text</option>
                      <option value="template">Named fields</option>
                      <option value="formula">Formula</option>
                    </select>
                  </Field>
                  <textarea data-editor-control="App-051"
                    id="object-content"
                    aria-label="Text content"
                    rows={4}
                    value={current.text}
                    onChange={(e) => property({ text: e.target.value })}
                  />
                  <p className="property-hint">
                    Use {"{{field}}"} to insert a named data source. Select Formula to calculate a value.
                  </p>
                </section>
              )}
              {current.type === "barcode" && (
                <section>
                  <h3>Barcode</h3>
                  <Field label="Data source">
                    <select data-editor-control="App-052"
                      aria-label="Barcode data source"
                      value={current.dataMode ?? "template"}
                      onChange={(e) =>
                        property({ dataMode: e.target.value } as any)
                      }
                    >
                      <option value="literal">Embedded data</option>
                      <option value="template">Named fields</option>
                      <option value="formula">Formula</option>
                    </select>
                  </Field>
                  <Field label="Symbology">
                    <select data-editor-control="App-053"
                      value={current.symbology}
                      onChange={(e) =>
                        property({ symbology: e.target.value } as any)
                      }
                    >
                      {symbologies.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Data">
                    <textarea data-editor-control="App-054"
                      id="object-content"
                      aria-label="Barcode data"
                      rows={3}
                      value={current.value}
                      onChange={(e) => property({ value: e.target.value })}
                    />
                  </Field>
                </section>
              )}
              {(current.type === "text" || current.type === "barcode") && current.dataMode === "formula" && (
                <section>
                  <h3>Formula result</h3>
                  <p className="property-hint">Enter a formula in the content box above. Use named fields such as item or {'{{item}}'}, not spreadsheet cell addresses unless that is your field name.</p>
                  <p className="property-hint">Example: =CONCATENATE(LEFT(item,1),"-",MID(item,2,2),"-",RIGHT(item,1))</p>
                  <FormulaCatalog />
                  {(() => {
                    try {
                      return <output aria-label="Formula result">{evaluateFormula(current.type === "text" ? current.text : current.value, data)}</output>;
                    } catch (error) {
                      return <p role="alert">{(error as Error).message}</p>;
                    }
                  })()}
                </section>
              )}
              {"fill" in current && (
                <section>
                  <h3>Line & fill</h3>
                  {current.type === "rectangle" && (
                    <Field label="Corner radius (mm)">
                      <input data-editor-control="App-055"
                        aria-label="Corner radius"
                        type="number"
                        min="0"
                        step=".1"
                        value={(current.cornerRadiusUm ?? 0) / 1000}
                        onChange={(e) =>
                          property({
                            cornerRadiusUm: Math.max(0, Math.round(Number(e.target.value) * 1000)),
                          } as any)
                        }
                      />
                    </Field>
                  )}
                  <Field label="Thickness (mm)">
                    <input data-editor-control="App-056"
                      aria-label="Thickness"
                      type="number"
                      min="0"
                      step=".1"
                      value={current.strokeUm / 1000}
                      onChange={(e) =>
                        property({
                          strokeUm: Math.round(Number(e.target.value) * 1000),
                        } as any)
                      }
                    />
                  </Field>
                  <Field label="Fill">
                    <select data-editor-control="App-057"
                      value={current.fill}
                      disabled={current.type === "line"}
                      title={current.type === "line" ? "Lines use their stroke and have no fill area" : undefined}
                      onChange={(e) =>
                        property({ fill: e.target.value } as any)
                      }
                    >
                      <option>none</option>
                      <option>black</option>
                      <option>white</option>
                    </select>
                  </Field>
                  {current.type === "line" && <p className="property-hint">Lines use their stroke and have no fill area.</p>}
                </section>
              )}
              </fieldset>
              <section>
                <h3>Arrange</h3>
                <p className="property-hint">Alignment and grouping require two unlocked objects; distribution requires three.</p>
                <div className="arrange-tools">
                  {[
                    [AlignStartVertical, "left", "Align left"],
                    [AlignCenterVertical, "center-x", "Horizontal centres"],
                    [AlignEndVertical, "right", "Align right"],
                    [AlignStartHorizontal, "top", "Align top"],
                    [AlignCenterHorizontal, "center-y", "Vertical centres"],
                    [AlignEndHorizontal, "bottom", "Align bottom"],
                  ].map(([Icon, action, label]) => (
                    <Tool auditId="App-058"
                      key={String(action)}
                      icon={Icon}
                      label={String(label)}
                      onClick={() => arrangeSelected(String(action))}
                    />
                  ))}
                  <Tool auditId="App-059"
                    icon={ArrowUpToLine}
                    label="Bring to front"
                    onClick={() => order(true)}
                  />
                  <Tool auditId="App-060"
                    icon={ArrowDownToLine}
                    label="Send to back"
                    onClick={() => order(false)}
                  />
                  <Tool auditId="App-061"
                    icon={RotateCw}
                    label="Rotate 90 degrees"
                    onClick={() => arrangeSelected("rotate")}
                  />
                  <Tool auditId="App-062"
                    icon={GroupIcon}
                    label="Group"
                    onClick={() => group()}
                  />
                  <Tool auditId="App-063"
                    icon={Ungroup}
                    label="Ungroup"
                    onClick={() => group(true)}
                  />
                  <Tool auditId="App-064"
                    icon={Trash2}
                    label="Delete selection"
                    onClick={remove}
                  />
                </div>
                <div className="arrange-links">
                  <button data-editor-control="App-065" disabled={!!unavailable("Centre on label ↔")} title={unavailable("Centre on label ↔")} onClick={() => arrangeSelected("label-x")}>
                    Centre on label ↔
                  </button>
                  <button data-editor-control="App-066" disabled={!!unavailable("Centre on label ↕")} title={unavailable("Centre on label ↕")} onClick={() => arrangeSelected("label-y")}>
                    Centre on label ↕
                  </button>
                  <button data-editor-control="App-067" disabled={!!unavailable("Distribute horizontally")} title={unavailable("Distribute horizontally")} onClick={() => arrangeSelected("distribute-x")}>
                    Distribute horizontally
                  </button>
                  <button data-editor-control="App-068" disabled={!!unavailable("Distribute vertically")} title={unavailable("Distribute vertically")} onClick={() => arrangeSelected("distribute-y")}>
                    Distribute vertically
                  </button>
                </div>
              </section>
            </>
          ) : (
            <div className="inspector-empty">
              <MousePointer2 size={30} strokeWidth={1} />
              <b>Select an object</b>
              <p>
                Click an object on the label or in the toolbox to edit its
                properties.
              </p>
              <button data-editor-control="App-069" className="btn btn-sm" onClick={() => setModal("setup")}>
                Page setup
              </button>
            </div>
          )}
        </aside>
        <div className="arrange-rail">
          <Tool auditId="App-070"
            icon={AlignStartVertical}
            label="Align left"
            onClick={() => arrangeSelected("left")}
          />
          <Tool auditId="App-071"
            icon={AlignEndVertical}
            label="Align right"
            onClick={() => arrangeSelected("right")}
          />
          <Tool auditId="App-072"
            icon={AlignStartHorizontal}
            label="Align top"
            onClick={() => arrangeSelected("top")}
          />
          <Tool auditId="App-073"
            icon={AlignEndHorizontal}
            label="Align bottom"
            onClick={() => arrangeSelected("bottom")}
          />
          <span />
          <Tool auditId="App-074"
            icon={AlignCenterVertical}
            label="Centre horizontal"
            onClick={() => arrangeSelected("center-x")}
          />
          <Tool auditId="App-075"
            icon={AlignCenterHorizontal}
            label="Centre vertical"
            onClick={() => arrangeSelected("center-y")}
          />
          <span />
          <Tool auditId="App-076"
            icon={RotateCw}
            label="Rotate"
            onClick={() => arrangeSelected("rotate")}
          />
        </div>
      </div>
      <footer className="statusbar" role="status">
        <span>
          {busy ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            <CheckCircle2 size={13} />
          )}{" "}
          {status}
        </span>
        <span>
          {selected.length ? `${selected.length} selected` : "No selection"}
        </span>
        <span>
          {unit === "mm"
            ? (template.widthUm / 1000).toFixed(1)
            : (template.widthUm / 25400).toFixed(2)}{" "}
          ×{" "}
          {unit === "mm"
            ? (template.heightUm / 1000).toFixed(1)
            : (template.heightUm / 25400).toFixed(2)}{" "}
          {unit}
        </span>
        <span>{(profile.dotsPerMm * 25.4) | 0} dpi</span>
        <span>{Math.round(zoom * 100)}%</span>
      </footer>

      {modal === "new" && (
        <Modal error={error} title="New project" onClose={() => setModal("")}>
          <p>
            Create a blank label project. Your current draft remains available
            in File → Recover draft until the new project is edited.
          </p>
          <button data-editor-control="App-077"
            className="btn btn-primary btn-sm"
            onClick={() => load(newProject())}
          >
            Create blank project
          </button>
          <button data-editor-control="App-078" className="btn btn-sm" onClick={() => load(demoProject())}>
            Open receiving-label example
          </button>
        </Modal>
      )}
      {modal === "drafts" && (
        <Modal error={error} title="Recover Draft" onClose={() => setModal("")}>
          <div className="project-list">
            {recoveredDrafts(localStorage.getItem("barista-drafts")).map((d) => (
              <button data-editor-control="App-079"
                key={d.project.id}
                onClick={() => {
                  load({ ...d.project, revision: d.revision });
                  setSavedJSON("");
                }}
              >
                <span>{d.project.name}</span>
                <small>Recovered local draft</small>
              </button>
            ))}
            {!recoveredDrafts(localStorage.getItem("barista-drafts")).length && <p>No valid recovered drafts are available.</p>}
          </div>
        </Modal>
      )}
      {modal === "conflict" && (
        <Modal error={error} title="Project Changed on Server" onClose={() => setModal("")}>
          <p>
            Another user saved a newer revision. Your edits have not overwritten
            their changes.
          </p>
          <div className="dialog-actions">
            <button data-editor-control="App-080"
              className="btn btn-sm"
              onClick={() =>
                run(async () => load(await api(`/projects/${project.id}`)))
              }
            >
              Open latest revision
            </button>
            <button data-editor-control="App-081"
              className="btn btn-primary btn-sm"
              onClick={() => {
                change({ ...project, id: id(), name: project.name + " copy" });
                setRevision(0);
                setSavedJSON("");
                setModal("");
              }}
            >
              Keep edits as new project
            </button>
          </div>
        </Modal>
      )}
      {modal === "library" && (
        <Modal error={error} title="Open project" onClose={() => setModal("")} wide>
          <div className="dialog-actions">
            <button data-editor-control="App-082"
              className="btn btn-sm"
              onClick={() => file.current?.click()}
            >
              <FolderOpen size={15} />
              Import file
            </button>
          </div>
          <div className="project-list">
            {library.map((p) => (
              <button data-editor-control="App-083" key={p.id} onClick={() => load(p)}>
                <Layers size={22} />
                <span>
                  <b>{p.name}</b>
                  <small>
                    {p.templates.length} template(s) · revision {p.revision}
                  </small>
                </span>
                <span>
                  {p.updatedAt
                    ? new Date(p.updatedAt).toLocaleDateString()
                    : ""}
                </span>
              </button>
            ))}
            {!library.length && (
              <p>No saved projects yet. Save your label or import a project.</p>
            )}
          </div>
        </Modal>
      )}
      {modal === "setup" && (
        <Modal error={error} title="Page Setup" onClose={() => setModal("")}>
          <div className="dialog-tabs">
            <button data-editor-control="App-084"
              type="button"
              className={setupTab === "page" ? "active" : ""}
              onClick={() => setSetupTab("page")}
            >
              Page
            </button>
            <button data-editor-control="App-085"
              type="button"
              className={setupTab === "layout" ? "active" : ""}
              onClick={() => setSetupTab("layout")}
            >
              Layout
            </button>
          </div>
          {setupTab === "page" ? (
            <>
              <Field label="Project name">
                <input data-editor-control="App-086"
                  value={project.name}
                  onChange={(e) => change({ ...project, name: e.target.value })}
                />
              </Field>
              <Field label="Template name">
                <input data-editor-control="App-087"
                  value={template.name}
                  onChange={(e) =>
                    change({
                      ...project,
                      templates: project.templates.map((t) =>
                        t.id === template.id ? { ...t, name: e.target.value } : t,
                      ),
                    })
                  }
                />
              </Field>
              {(["widthUm", "heightUm"] as const).map((k) => (
                <Field
                  key={k}
                  label={`${k === "widthUm" ? "Width" : "Height"} (${unit})`}
                >
                  <input data-editor-control="App-088"
                    type="number"
                    min=".1"
                    step=".1"
                    value={Number((template[k] / factor).toFixed(3))}
                    onChange={(e) =>
                      change({
                        ...project,
                        templates: project.templates.map((t) =>
                          t.id === template.id
                            ? {
                                ...t,
                                [k]: Math.min(2_000_000, Math.max(
                                  100,
                                  Math.round(Number(e.target.value) * factor),
                                )),
                              }
                            : t,
                        ),
                      })
                    }
                  />
                </Field>
              ))}
              <div className="page-diagram">
                {template.widthUm >= template.heightUm ? (
                  <RectangleHorizontal size={70} strokeWidth={1} />
                ) : (
                  <RectangleVertical size={70} strokeWidth={1} />
                )}
                <span>
                  {(template.widthUm / 1000).toFixed(1)} ×{" "}
                  {(template.heightUm / 1000).toFixed(1)} mm
                </span>
              </div>
            </>
          ) : (
            <>
              <Field label="Orientation">
                <select data-editor-control="App-089"
                  disabled={template.widthUm === template.heightUm}
                  title={template.widthUm === template.heightUm ? "Square labels have no distinct orientation" : undefined}
                  value={
                    template.widthUm >= template.heightUm
                      ? "landscape"
                      : "portrait"
                  }
                  onChange={(e) => {
                    const target = e.target.value;
                    const isCurrentlyLandscape =
                      template.widthUm >= template.heightUm;
                    if (
                      (target === "portrait" &&
                        isCurrentlyLandscape &&
                        template.widthUm !== template.heightUm) ||
                      (target === "landscape" && !isCurrentlyLandscape)
                    ) {
                      change({
                        ...project,
                        templates: project.templates.map((t) =>
                          t.id === template.id
                            ? { ...t, widthUm: t.heightUm, heightUm: t.widthUm }
                            : t,
                        ),
                      });
                    }
                  }}
                >
                  <option value="landscape">Landscape</option>
                  <option value="portrait">Portrait</option>
                </select>
              </Field>
              <Field label="Rotate / Swap">
                <button data-editor-control="App-090"
                  type="button"
                  disabled={template.widthUm === template.heightUm}
                  title={template.widthUm === template.heightUm ? "Square label dimensions are already equal" : undefined}
                  className="btn btn-sm"
                  style={{ flex: 1 }}
                  onClick={() =>
                    change({
                      ...project,
                      templates: project.templates.map((t) =>
                        t.id === template.id
                          ? { ...t, widthUm: t.heightUm, heightUm: t.widthUm }
                          : t,
                      ),
                    })
                  }
                >
                  Swap Width & Height ({Number((template.heightUm / factor).toFixed(1))} × {Number((template.widthUm / factor).toFixed(1))} {unit})
                </button>
              </Field>
              {template.widthUm === template.heightUm && <p className="property-hint">Square labels have no distinct orientation; width and height are already equal.</p>}
              <Field label="Rows">
                <input data-editor-control="App-091"
                  type="number"
                  min="1"
                  max="1"
                  value={1}
                  readOnly
                  title="Thermal roll format uses 1 label per form"
                />
              </Field>
              <Field label="Columns">
                <input data-editor-control="App-092"
                  type="number"
                  min="1"
                  max="1"
                  value={1}
                  readOnly
                  title="Thermal roll format uses 1 label per form"
                />
              </Field>
              <Field label={`Margins (${unit})`}>
                <input data-editor-control="App-093"
                  type="text"
                  value={`0 ${unit} (edge-to-edge)`}
                  readOnly
                  title="Continuous thermal label stock uses edge-to-edge printable bounds"
                />
              </Field>
              <div className="property-hint">
                Thermal roll media: 1 × 1 label per form with edge-to-edge printable bounds.
              </div>
              <div className="page-diagram">
                {template.widthUm >= template.heightUm ? (
                  <RectangleHorizontal size={70} strokeWidth={1} />
                ) : (
                  <RectangleVertical size={70} strokeWidth={1} />
                )}
                <span>
                  {template.widthUm >= template.heightUm
                    ? "Landscape"
                    : "Portrait"}{" "}
                  · {(template.widthUm / 1000).toFixed(1)} ×{" "}
                  {(template.heightUm / 1000).toFixed(1)} mm
                </span>
              </div>
            </>
          )}
          <div className="dialog-actions">
            <button data-editor-control="App-094"
              className="btn btn-primary btn-sm"
              onClick={() => setModal("")}
            >
              OK
            </button>
          </div>
        </Modal>
      )}
      {modal === "print" && (
        <Modal error={error} title="Print Preview & Print" onClose={() => setModal("")} wide>
          {printerWarnings.map((warning, i) => (
            <p className="diagnostic warning" key={i}>
              {warning}
            </p>
          ))}
          <div className="print-grid">
            <div>
              <Field label="Printer">
                <select data-editor-control="App-095"
                  value={printerId}
                  onChange={(e) => {
                    setPrinterId(e.target.value);
                    setCompilation(undefined);
                  }}
                >
                  <option value={zt411.id}>
                    ZT411 · 203 dpi (preview only)
                  </option>
                  {printers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button data-editor-control="App-096"
                  className="btn btn-xs"
                  disabled={busy}
                  onClick={() => run(refreshPrinters)}
                >
                  Refresh printers
                </button>
              </Field>
              <Field label="Identical copies">
                <input data-editor-control="App-097"
                  type="number"
                  min="1"
                  max="10000"
                  value={quantity}
                  onChange={(e) => {
                    setQuantity(Number(e.target.value));
                    setCompilation(undefined);
                  }}
                />
              </Field>
              {project.variables.map((v) => (
                <Field key={v.name} label={v.name}>
                  <input data-editor-control="App-098"
                    value={data[v.name] ?? ""}
                    readOnly={v.formula !== undefined}
                    title={v.formula !== undefined ? "Calculated from a named formula; edit it in Named Data Sources" : undefined}
                    onChange={(e) => {
                      setValues({ ...values, [v.name]: e.target.value });
                      setCompilation(undefined);
                    }}
                  />
                </Field>
              ))}
              <button data-editor-control="App-099"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => run(compile)}
              >
                <ScanEye size={15} />
                Generate preview
              </button>
              <div className="print-details">
                {compilation
                  ? `${compilation.widthDots} × ${compilation.heightDots} dots`
                  : "Generate a preview to validate this label."}
                <p>The exact compiled job shown here is sent to the printer.</p>
                {!printers.some(p => p.id === profile.id) && <p>Select a configured printer to enable printing. The default profile supports preview and ZPL download.</p>}
              </div>
            </div>
            <div className="print-preview">
              {busy ? (
                <span className="loading loading-spinner" />
              ) : compilation?.previewBase64 ? (
                <img
                  alt="Authoritative monochrome print preview"
                  src={
                    compilation.previewBase64.startsWith("data:")
                      ? compilation.previewBase64
                      : `data:image/png;base64,${compilation.previewBase64}`
                  }
                />
              ) : (
                <p>No print preview</p>
              )}
            </div>
          </div>
          {compilation?.diagnostics.map((d, i) => (
            <div key={i} className={`diagnostic ${d.severity}`}>
              {d.message}
            </div>
          ))}
          <details className="zpl-details">
            <summary data-editor-control="App-100">Generated ZPL</summary>
            <pre>{compilation?.zpl ?? "Compile the label to inspect ZPL."}</pre>
          </details>
          <div className="dialog-actions">
            <button data-editor-control="App-101"
              className="btn btn-sm"
              disabled={busy || !compilation?.zpl}
              title={busy ? "Wait for the current operation to finish" : !compilation?.zpl ? "Generate a valid preview first" : undefined}
              onClick={() =>
                compilation &&
                download(
                  `/compilations/${compilation.id}/zpl`,
                  `${project.name}.zpl`,
                ).catch((e) => setError(e.message))
              }
            >
              <Download size={14} />
              Download ZPL
            </button>
            <button data-editor-control="App-102"
              className="btn btn-primary btn-sm"
              title={busy ? "Wait for the current operation to finish" : !compilation?.zpl ? "Generate a valid preview first" : compilation.diagnostics.some(d => d.severity === "error") ? "Resolve preview errors before printing" : !printers.some(p => p.id === profile.id) ? "Select a configured printer" : undefined}
              disabled={
                busy ||
                !compilation?.zpl ||
                compilation.diagnostics.some((d) => d.severity === "error") ||
                !printers.some((p) => p.id === profile.id)
              }
              onClick={physicalPrint}
            >
              <Printer size={14} />
              Print
            </button>
          </div>
        </Modal>
      )}
      {modal === "data" && (
        <Modal error={error}
          title="Named Data Sources & CSV Batch"
          onClose={() => setModal("")}
          wide
        >
          <div className="data-fields">
            {project.variables.map((v, i) => (
              <div className="data-field-row" key={i}>
                <input data-editor-control="App-103"
                  aria-label="Field name"
                  pattern="[A-Za-z_][A-Za-z0-9_]*"
                  placeholder="field_name"
                  value={v.name}
                  onChange={(e) =>
                    change({
                      ...project,
                      variables: project.variables.map((x, n) =>
                        n === i
                          ? {
                              ...x,
                              name: e.target.value.replace(
                                /[^A-Za-z0-9_]/g,
                                "",
                              ),
                            }
                          : x,
                      ),
                    })
                  }
                />
                {(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name) || project.variables.some((x, n) => n !== i && x.name === v.name)) && <p role="alert">Use a unique field name starting with a letter or underscore.</p>}
                {v.formula === undefined ? <input data-editor-control="App-104"
                  aria-label="Default value" placeholder="Default value" value={v.defaultValue}
                  onChange={e => change({ ...project, variables: project.variables.map((x, n) => n === i ? { ...x, defaultValue: e.target.value } : x) })}
                /> : <textarea data-editor-control="App-105"
                  aria-label="Named formula" placeholder="=LEFT(item,1)" value={v.formula} rows={3}
                  onChange={e => change({ ...project, variables: project.variables.map((x, n) => n === i ? { ...x, formula: e.target.value } : x) })}
                />}
                <select data-editor-control="App-106" aria-label="Named source type" value={v.formula === undefined ? "input" : "formula"}
                  onChange={e => change({ ...project, variables: project.variables.map((x, n) => n === i ? { ...x, formula: e.target.value === "formula" ? "" : undefined } : x) })}>
                  <option value="input">Input value</option>
                  <option value="formula">Formula</option>
                </select>
                {v.formula !== undefined && <output aria-label={`Result for ${v.name}`}>{resolvedSources.errors.find(error => error.name === v.name)?.message ?? data[v.name]}</output>}
                <button data-editor-control="App-107"
                  className="btn btn-ghost btn-xs"
                  aria-label="Remove field"
                  onClick={() =>
                    change({
                      ...project,
                      variables: project.variables.filter((_, n) => n !== i),
                    })
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button data-editor-control="App-108"
              className="btn btn-sm"
              onClick={() =>
                change({
                  ...project,
                  variables: [
                    ...project.variables,
                    {
                      name: nextFieldName(project.variables.map(v => v.name)),
                      defaultValue: "",
                    },
                  ],
                })
              }
            >
              <Plus size={14} />
              Add named field
            </button>
          </div>
          <p className="property-hint">Create a Formula source to reuse an expression across elements. Insert its name with {'{{name}}'} or reference it in another formula. Formula sources are calculated for each CSV row.</p>
          {project.variables.some(v => v.formula !== undefined) && <FormulaCatalog />}
          <hr />
          <h3>CSV batch data</h3>
          <button data-editor-control="App-109"
            className="btn btn-sm"
            onClick={() => csvFile.current?.click()}
          >
            Load CSV
          </button>
          {!!csvRows.length && (
            <>
              <p>
                {csvRows.length} rows loaded. All rows are compiled and
                validated before any are queued.
              </p>
              {project.variables.filter(v => v.formula === undefined).map((v) => (
                <Field key={v.name} label={v.name}>
                  <select data-editor-control="App-110"
                    value={mapping[v.name] ?? ""}
                    onChange={(e) =>
                      setMapping({ ...mapping, [v.name]: e.target.value })
                    }
                  >
                    <option value="">Choose CSV column</option>
                    {csvFields.map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </select>
                </Field>
              ))}
              <Field label="Quantity column">
                <select data-editor-control="App-111"
                  value={quantityColumn}
                  onChange={(e) => setQuantityColumn(e.target.value)}
                >
                  <option value="">Use print quantity ({quantity})</option>
                  {csvFields.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </Field>
              <Field label="Preview row">
                <input data-editor-control="App-112"
                  type="number"
                  min="1"
                  max={csvRows.length}
                  value={sampleRow + 1}
                  onChange={(e) =>
                    setSampleRow(
                      Math.max(
                        0,
                        Math.min(
                          csvRows.length - 1,
                          Math.floor(Number(e.target.value)) - 1,
                        ),
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Printer">
                <select data-editor-control="App-113"
                  value={printerId}
                  onChange={(e) => setPrinterId(e.target.value)}
                >
                  <option value={zt411.id}>Choose configured printer</option>
                  {printers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="csv-sample">
                <pre>{JSON.stringify(csvRows[sampleRow], null, 2)}</pre>
              </div>
              <button data-editor-control="App-114"
                className="btn btn-primary btn-sm"
                disabled={busy || !printers.some(p => p.id === profile.id) || project.variables.some(v => v.formula === undefined && !mapping[v.name])}
                title={busy ? "Wait for the current operation to finish" : !printers.some(p => p.id === profile.id) ? "Select a configured printer" : project.variables.some(v => v.formula === undefined && !mapping[v.name]) ? "Map every input field to a CSV column" : undefined}
                onClick={printBatch}
              >
                Validate & queue batch
              </button>
              {(!printers.some(p => p.id === profile.id) || project.variables.some(v => v.formula === undefined && !mapping[v.name])) && <p className="property-hint">Select a configured printer and map every input field to a CSV column before queuing.</p>}
            </>
          )}
        </Modal>
      )}
      {modal === "jobs" && (
        <Modal error={error} title="Print Jobs" onClose={() => setModal("")} wide>
          <p className="property-hint">
            Sent means transmission completed. Physical completion is not
            verified.
          </p>
          <div className="jobs-list">
            {jobs.map((j) => (
              <div key={j.id}>
                <Printer size={19} />
                <span>
                  <b>{j.printer.name}</b>
                  <small>
                    {new Date(j.createdAt).toLocaleString()} ·{" "}
                    {j.id.slice(0, 8)}
                  </small>
                  {j.error && <small>{j.error}</small>}
                </span>
                <span
                  className={`badge ${j.state === "sent" ? "badge-success" : j.state === "failed" || j.state === "outcome-unknown" ? "badge-warning" : "badge-ghost"}`}
                >
                  {j.state}
                </span>
                {["sent", "failed", "outcome-unknown"].includes(j.state) && (
                  <button data-editor-control="App-115"
                    className="btn btn-xs"
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          "This job may already have printed. Queue an explicit reprint of the original compiled job?",
                        )
                      )
                        run(async () => {
                          await api("/jobs", {
                            compilationId: j.compilationId,
                            idempotencyKey: id(),
                          });
                          setJobs(await api("/jobs"));
                        });
                    }}
                  >
                    Reprint
                  </button>
                )}
                {j.state === "queued" && (
                  <button data-editor-control="App-116"
                    className="btn btn-xs"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await api(`/jobs/${j.id}/cancel`, {});
                        setJobs(await api("/jobs"));
                      })
                    }
                  >
                    Cancel
                  </button>
                )}
              </div>
            ))}
            {!jobs.length && <p>No print jobs yet.</p>}
          </div>
        </Modal>
      )}
      {modal === "printers" && admin && (
        <PrinterConfiguration onClose={() => setModal("")} onChanged={() => void refreshPrinters()} />
      )}
      {modal === "history" && (
        <Modal error={error} title="Revision History" onClose={() => setModal("")}>
          <div className="project-list">
            {revisions.map((r) => (
              <button data-editor-control="App-117"
                key={r.revision}
                onClick={() => {
                  setHistory((h) =>
                    transition(h, projectSchema.parse(r.project)),
                  );
                  setTemplateId(r.project.templates[0].id);
                  setSelected([]);
                  setModal("");
                  setStatus(`Revision ${r.revision} loaded as draft`);
                }}
              >
                <span>Revision {r.revision}</span>
                <small>
                  {r.project.updatedAt
                    ? new Date(r.project.updatedAt).toLocaleString()
                    : ""}
                </small>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {modal === "import" && (
        <Modal error={error}
          title="BarTender Import Report"
          onClose={() => setModal("")}
          wide
        >
          {importProgress ? (
            <p>
              <span className="loading loading-spinner loading-sm" /> Inspecting
              file and decoding archive…
            </p>
          ) : importResult ? (
            <>
              <p>
                Archive version:{" "}
                <b>{importResult.archiveVersion ?? "Unknown"}</b>
              </p>
              {importResult.previewBase64 && (
                <img
                  className="import-preview"
                  alt="Embedded BarTender preview (reference only)"
                  src={
                    importResult.previewBase64.startsWith("data:")
                      ? importResult.previewBase64
                      : `data:image/png;base64,${importResult.previewBase64}`
                  }
                />
              )}
              <p>
                The source file is preserved on the server. The thumbnail is a
                reference, not a converted editable label.
              </p>
              {importResult.diagnostics?.map((d: any, i: number) => (
                <div key={i} className={`diagnostic ${d.severity}`}>
                  {d.message}
                </div>
              ))}
              {importResult.project && (
                <button data-editor-control="App-118"
                  className="btn btn-primary btn-sm"
                  onClick={() => load(importResult.project)}
                >
                  Open imported project
                </button>
              )}
            </>
          ) : (
            <p>No import result.</p>
          )}
        </Modal>
      )}
    </div>
    </ActionReason.Provider>
  );
}

function FormulaCatalog() {
  return <details><summary data-editor-control="App-119">Formula functions and fields</summary>
    <p>Use a named field, {'{{field}}'}, or FIELD("field"). Join expressions with &amp;. MID positions start at 1. An initial = is optional.</p>
    {formulaFunctions.map(fn => <p key={fn.name}><code>{fn.signature}</code> — {fn.description}{fn.aliases?.length ? ` (aliases: ${fn.aliases.join(", ")})` : ""}</p>)}
  </details>;
}
