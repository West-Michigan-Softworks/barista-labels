import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export default function Modal({ title, children, onClose, wide = false, busy = false, error }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean; busy?: boolean; error?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const blocked = useRef(busy);
  blocked.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => Array.from(root.current!.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
    )).filter(el => el.getClientRects().length && !el.hidden && el.tabIndex !== -1);
    (controls()[0] ?? root.current)?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (!blocked.current) close.current();
      } else if (event.key === "Tab") {
        const items = controls(), index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length) { event.preventDefault(); root.current?.focus(); }
        else if (index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
          event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus();
        }
      }
    };
    const focus = (event: FocusEvent) => {
      if (!root.current?.contains(event.target as Node)) (controls()[0] ?? root.current)?.focus();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("focusin", focus);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("focusin", focus);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <div ref={root} className="modal modal-open" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
    <div className={`modal-box desktop-dialog ${wide ? "wide" : ""}`}>
      <header><h2>{title}</h2><button data-editor-control="Modal-001" className="btn btn-ghost btn-xs" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={17} /></button></header>
      <div className="dialog-body">{error && <p className="alert alert-error" role="alert">{error}</p>}{children}</div>
    </div>
    <button data-editor-control="Modal-002" className="modal-backdrop" aria-label="Close" disabled={busy} onClick={onClose} tabIndex={-1} />
  </div>;
}
