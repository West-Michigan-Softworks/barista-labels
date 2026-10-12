import { useEffect, useState } from "react";
import type { Project, PrinterProfile } from "../shared/model";
import { api } from "./api";
export function usePreview(
  project: Project,
  templateId: string,
  data: Record<string, string>,
  printer: PrinterProfile,
  enabled = true,
) {
  const [png, setPng] = useState("");
  const signature = JSON.stringify({ project, templateId, data, printer });
  useEffect(() => {
    let stale = false;
    setPng("");
    if (!enabled) return;
    const timer = setTimeout(() => {
      api("/render", { project, templateId, data, printer })
        .then((result) => {
          if (!stale) setPng(result.previewBase64 ?? "");
        })
        .catch(() => {
          /* Compilation dialog presents blocking diagnostics. */
        });
    }, 450);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [signature, enabled]);
  return png;
}
