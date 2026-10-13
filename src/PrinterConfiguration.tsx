import { useEffect, useRef, useState } from "react";
import { id, zt411, type PrinterProfile } from "../shared/model";
import { api } from "./api";
import Modal from "./Modal";

export default function PrinterConfiguration({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [printers, setPrinters] = useState<PrinterProfile[]>([]);
  const [draft, setDraft] = useState<PrinterProfile>({ ...zt411, id: id(), name: "Zebra ZT411" });
  const [message, setMessage] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const sql = draft.id.startsWith("sql:");
  const refresh = async () => {
    const [list, report] = await Promise.all([api<PrinterProfile[]>("/printers"), api<{ diagnostics: { message: string }[] }>("/printers/diagnostics")]);
    setPrinters(list); setWarnings(report.diagnostics.map(d => d.message));
  };
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { locked.current = false; setBusy(false); }
  };
  useEffect(() => { void run(refresh); }, []);
  return <Modal title="Printer Configuration" onClose={onClose} wide busy={busy}>
        {error && <p className="alert alert-error" role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
        {warnings.map((warning, i) => <p className="diagnostic warning" key={i}>{warning}</p>)}
        <button data-editor-control="PrinterConfiguration-001" className="btn btn-sm" disabled={busy} onClick={() => void run(refresh)}>Refresh printer list</button>
        <div className="printer-grid"><div className="printer-list">
          {printers.map(p => <button data-editor-control="PrinterConfiguration-002" key={p.id} disabled={busy} className={draft.id === p.id ? "selected" : ""} onClick={() => setDraft(p)}>{p.name}</button>)}
          <button data-editor-control="PrinterConfiguration-003" disabled={busy} onClick={() => setDraft({ ...zt411, id: id(), name: "Zebra ZT411" })}>New printer</button>
        </div><div>
          {sql && <p>Managed by BYAPPS · LabelPrint · dbo.printersZPL. Edit this printer in the source table.</p>}
          {(["name", "host", "port", "dotsPerMm", "widthDots", "offsetX", "offsetY"] as const).map(key => <label className="property-field" key={key}>
            <span>{{ name: "Name", host: "IP address / hostname", port: "TCP port", dotsPerMm: "Dots per mm", widthDots: "Printable width (dots)", offsetX: "X offset (dots)", offsetY: "Y offset (dots)" }[key]}</span>
            <input data-editor-control="PrinterConfiguration-004" disabled={sql || busy} type={key === "name" || key === "host" ? "text" : "number"} value={draft[key]} onChange={e => setDraft({ ...draft, [key]: key === "name" || key === "host" ? e.target.value : Number(e.target.value) })} />
          </label>)}
          <label className="property-field"><span>Location number</span><input data-editor-control="PrinterConfiguration-005" type="number" step={1} disabled={sql || busy} value={draft.location ?? ""} onChange={e => setDraft({ ...draft, location: e.target.value === "" ? null : Number(e.target.value) })} /></label>
          <label className="property-field"><span>Media</span><select data-editor-control="PrinterConfiguration-006" aria-label="Media" disabled={sql || busy} value={draft.media ?? "gap"} onChange={e => setDraft({ ...draft, media: e.target.value as PrinterProfile["media"] })}>
            <option value="gap">Gap / web</option><option value="continuous">Continuous</option><option value="mark">Black mark</option>
          </select></label>
          <div className="dialog-actions">
            <button data-editor-control="PrinterConfiguration-007" className="btn btn-sm" disabled={busy || !printers.some(p => p.id === draft.id)} onClick={() => void run(async () => { await api(`/printers/${draft.id}/check`, {}); setMessage("TCP connection succeeded; no label was printed"); })}>Check connection</button>
            <button data-editor-control="PrinterConfiguration-008" className="btn btn-primary btn-sm" disabled={sql || busy} onClick={() => void run(async () => {
              const exists = printers.some(p => p.id === draft.id);
              const saved = await api<PrinterProfile>(exists ? `/printers/${draft.id}` : "/printers", draft, exists ? "PUT" : "POST");
              setDraft(saved); await refresh(); onChanged(); setMessage("Printer profile saved");
            })}>Save printer</button>
            <button data-editor-control="PrinterConfiguration-009" className="btn btn-sm" disabled={sql || busy || !printers.some(p => p.id === draft.id)} onClick={() => {
              if (window.confirm(`Delete printer ${draft.name}?`)) void run(async () => { await api(`/printers/${draft.id}`, undefined, "DELETE"); setDraft({ ...zt411, id: id(), name: "Zebra ZT411" }); await refresh(); onChanged(); });
            }}>Delete printer</button>
          </div>
        </div></div>
  </Modal>;
}
