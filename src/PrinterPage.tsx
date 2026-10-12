import { useEffect, useRef, useState } from "react";
import { id, type PrinterProfile } from "../shared/model";
import { parseLabelCsv, type PreparedPreview, type PreparedPrint, type PublishedLabel } from "../shared/publishing";
import { api, download } from "./api";
import PrinterConfiguration from "./PrinterConfiguration";

export default function PrinterPage({ user, admin, onSignOut, onSwitchMode }: {
  user: string; admin: boolean; onSignOut?: () => void; onSwitchMode?: () => void;
}) {
  const [labels, setLabels] = useState<PublishedLabel[]>([]), [printers, setPrinters] = useState<PrinterProfile[]>([]);
  const [labelId, setLabelId] = useState(""), [printerId, setPrinterId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [csv, setCsv] = useState(""), [fileName, setFileName] = useState(""), [quantity, setQuantity] = useState(1);
  const [preparation, setPreparation] = useState<PreparedPrint>(), [preview, setPreview] = useState<PreparedPreview>();
  const [row, setRow] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [status, setStatus] = useState(""), [jobs, setJobs] = useState<any[]>([]), [configure, setConfigure] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const lock = useRef(false), printKey = useRef(id()), reprintKeys = useRef(new Map<string, string>());
  const selected = labels.find(label => label.id === labelId);
  const locations = [...new Set(printers.flatMap(p => typeof p.location === "number" ? [p.location] : []))].sort((a, b) => a - b);
  const unassigned = printers.some(p => p.location == null);
  const filteredPrinters = locationId ? printers.filter(p => locationId === "unassigned" ? p.location == null : String(p.location) === locationId) : [];
  const printer = filteredPrinters.find(p => p.id === printerId);
  let csvCount = 0, csvError = "";
  if (selected?.fields.length && csv) {
    try { csvCount = parseLabelCsv(csv, selected.fields).length; } catch (e) { csvError = (e as Error).message; }
  }
  const count = selected?.fields.length ? csvCount : quantity;
  const signature = JSON.stringify({ labelId, version: selected?.version, locationId, printer, csv, quantity });
  useEffect(() => { setPreparation(undefined); setPreview(undefined); setRow(0); printKey.current = id(); setStatus(""); }, [signature]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  const refresh = async () => {
    const [catalog, devices, report] = await Promise.all([
      api<PublishedLabel[]>("/published-labels"), api<PrinterProfile[]>("/printers"),
      api<{ diagnostics: { message: string }[] }>("/printers/diagnostics"),
    ]);
    setLabels(catalog); setPrinters(devices); setWarnings(report.diagnostics.map(d => d.message));
  };
  useEffect(() => {
    let active = true;
    // Poll only status; catalog refresh is explicit so selections never silently move.
    const refreshJobs = async () => {
      try { const result = await api<any[]>("/jobs"); if (active) setJobs(result); }
      catch (e) { if (active) setError((e as Error).message); }
    };
    void run(refresh); void refreshJobs();
    const timer = setInterval(() => void refreshJobs(), 1500);
    return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    let active = true; setPreview(undefined);
    if (preparation) api<{ previews: PreparedPreview[] }>(`/printer/preparations/${preparation.id}/previews?offset=${row}&limit=1`)
      .then(result => { if (active) setPreview(result.previews[0]); })
      .catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [preparation, row]);
  return <main className="printer-workspace" data-theme="light">
    <header className="titlebar"><div className="brand"><span className="brand-square">B</span><b>Barista Labels</b><span className="title-divider">/</span><span>Printer</span></div>
      <div className="title-actions">{onSwitchMode && <button className="btn btn-sm" onClick={onSwitchMode}>Switch to Editor</button>}<span>{user}</span>{onSignOut && <button className="btn btn-sm" onClick={onSignOut}>Sign out</button>}</div>
    </header>
    <div className="printer-content">
      <div className="printer-heading"><div><h1>Print labels</h1><p>Select a published label and prepare your print.</p></div><div className="dialog-actions">
        <button className="btn btn-sm" disabled={busy} onClick={() => void run(refresh)}>Refresh catalog</button>
        {admin && <button className="btn btn-sm" disabled={busy} onClick={() => setConfigure(true)}>Printer configuration</button>}
      </div></div>
      {error && <p className="alert alert-error" role="alert">{error}</p>}
      {warnings.map((message, i) => <p className="diagnostic warning" key={i}>{message}</p>)}
      <div className="printer-workflow">
        <section className="printer-card"><h2>Label and data</h2>
          <label className="property-field"><span>Label template</span><select aria-label="Label template" value={labelId} disabled={busy} onChange={e => { setLabelId(e.target.value); setCsv(""); setFileName(""); setError(""); }}>
            <option value="">Select a published label</option>{labels.map(label => <option value={label.id} key={label.id}>{label.name} · {label.projectName}</option>)}
          </select></label>
          {!labels.length && !busy && <p>No published labels are available. An administrator must publish a label first.</p>}
          {selected && <p>Published version {selected.version}</p>}
          {!!selected?.fields.length && <>
            <p>One nonempty data row prints one label. Every field is required.</p>
            <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => download(`/published-labels/${selected.id}/csv`, "label-data.csv"))}>Download CSV template</button>
            <label className="property-field"><span>Upload populated CSV</span><input aria-label="Upload populated CSV" type="file" accept=".csv,text/csv" disabled={busy} onChange={e => {
              const file = e.target.files?.[0]; e.target.value = "";
              if (file) void run(async () => {
                setCsv(""); setFileName("");
                if (file.size > 16 * 1024 * 1024) throw new Error("CSV must be at most 16 MB");
                const text = await file.text(); setCsv(text); setFileName(file.name);
              });
            }} /></label>
            {fileName && <p>{fileName}</p>}{csvError && <p className="diagnostic error" role="alert">{csvError}</p>}
          </>}
          {selected && !selected.fields.length && <label className="property-field"><span>Quantity</span><input aria-label="Quantity" type="number" min={1} max={10000} value={quantity} disabled={busy} onChange={e => setQuantity(Number(e.target.value))} /></label>}
          <label className="property-field"><span>Location</span><select aria-label="Location" value={locationId} disabled={busy} onChange={e => { setLocationId(e.target.value); setPrinterId(""); }}>
            <option value="">Select a location</option>{locations.map(location => <option key={location} value={String(location)}>Location {location}</option>)}
            {unassigned && <option value="unassigned">Unassigned location</option>}
          </select></label>
          <label className="property-field"><span>Printer</span><select aria-label="Printer" value={printer ? printerId : ""} disabled={busy || !locationId} onChange={e => setPrinterId(e.target.value)}>
            <option value="">Select a printer</option>{filteredPrinters.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
          {!printers.length && !busy && <p>No configured printers are available.</p>}
          {!!printers.length && locationId && !filteredPrinters.length && <p>No printers are available at this location.</p>}
          <p className="label-count" aria-live="polite">Labels to print: <strong>{selected ? count : 0}</strong></p>
          <button className="btn btn-primary" disabled={busy || !selected || !printer || !!csvError || !Number.isInteger(count) || count < 1 || (!selected.fields.length && count > 10000)} onClick={() => void run(async () => {
            setPreparation(undefined); setPreview(undefined); setStatus("Validating every label…");
            const result = await api<PreparedPrint>("/printer/preparations", { publicationId: selected!.id, version: selected!.version, printerId,
              location: locationId === "unassigned" ? null : Number(locationId),
              ...(selected!.fields.length ? { csv } : { quantity }) });
            setRow(0); setPreparation(result); printKey.current = id(); setStatus(`Ready to print ${result.count} labels`);
          })}>{busy ? "Working…" : "Prepare preview"}</button>
        </section>
        <section className="printer-card"><h2>Print preview</h2>
          <div className="published-preview">{preview ? <img src={`data:image/png;base64,${preview.previewBase64}`} alt="Prepared label preview" /> : <p>{preparation ? "Loading preview…" : "Prepare your data to preview the labels."}</p>}</div>
          {preparation && <div className="preview-navigation"><button className="btn btn-sm" disabled={busy || row === 0} onClick={() => { setPreview(undefined); setRow(row - 1); }}>Previous label</button><span>Label {row + 1} of {preparation.rows}</span><button className="btn btn-sm" disabled={busy || row + 1 >= preparation.rows} onClick={() => { setPreview(undefined); setRow(row + 1); }}>Next label</button></div>}
          {preview?.diagnostics.map((d, i) => <p className={`diagnostic ${d.severity}`} key={i}>{d.message}</p>)}
          <p role="status">{status}</p>
          <button className="btn btn-primary" disabled={busy || !preparation || !preview} onClick={() => void run(async () => {
            const batch = await api<{ id: string }>("/printer/submissions", { preparationId: preparation!.id, idempotencyKey: printKey.current });
            setStatus(`Queued ${preparation!.count} labels · batch ${batch.id}`); setJobs(await api("/jobs"));
          })}>Print</button>
        </section>
      </div>
      <section className="printer-card printer-job-card"><h2>Print jobs</h2><p>Sent means transmitted to the printer; physical completion is unknown.</p>
        {!jobs.length && <p>No print jobs yet.</p>}
        {jobs.map(job => <div className="published-job" key={job.id}><div><b>{job.printer.name}</b><p>{job.quantity} label(s) · {job.state} · {job.batchId ? `batch ${job.batchId}` : job.id}</p>{job.error && <p className="diagnostic error">{job.error}</p>}</div>
          <div className="dialog-actions">{job.state === "queued" && <button className="btn btn-sm" disabled={busy} onClick={() => void run(async () => { await api(`/jobs/${job.id}/cancel`, {}); setJobs(await api("/jobs")); })}>Cancel</button>}
          {["sent", "failed", "outcome-unknown", "cancelled"].includes(job.state) && <button className="btn btn-sm" disabled={busy} onClick={() => {
            if (window.confirm("This label may already have printed. Queue an explicit reprint of the original compiled label?")) void run(async () => {
              if (!reprintKeys.current.has(job.id)) reprintKeys.current.set(job.id, id());
              await api(`/printer/jobs/${job.id}/reprint`, { idempotencyKey: reprintKeys.current.get(job.id) });
              reprintKeys.current.delete(job.id); setJobs(await api("/jobs")); setStatus("Reprint queued");
            });
          }}>Reprint</button>}</div>
        </div>)}
      </section>
    </div>
    {configure && <PrinterConfiguration onClose={() => setConfigure(false)} onChanged={() => void run(refresh)} />}
  </main>;
}
