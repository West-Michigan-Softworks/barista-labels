import { lazy, Suspense, useEffect, useState } from "react";
import { workspaceMode } from "../shared/access";
import PrinterPage from "./PrinterPage";
const Editor = lazy(() => import("./App"));

export default function Workspace({ user, roles, development, onSignOut }: {
  user: string; roles: string[]; development?: boolean; onSignOut?: () => void;
}) {
  const admin = roles.includes("Labels.Admin");
  const [mode, setMode] = useState(() => workspaceMode(location.pathname, admin));
  useEffect(() => {
    history.replaceState(null, "", `/${workspaceMode(location.pathname, admin)}`);
    const pop = () => {
      const next = workspaceMode(location.pathname, admin);
      history.replaceState(null, "", `/${next}`); setMode(next);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [admin]);
  const switchMode = () => {
    const next = mode === "editor" ? "printer" : "editor";
    history.pushState(null, "", `/${next}`); setMode(next);
  };
  return <>
    {admin && <div hidden={mode !== "editor"}><Suspense fallback={<p>Loading editor…</p>}>
      <Editor user={user} admin active={mode === "editor"} development={development} onSignOut={onSignOut} onSwitchMode={switchMode} />
    </Suspense></div>}
    {mode === "printer" && <PrinterPage user={user} admin={admin} onSignOut={onSignOut} onSwitchMode={admin ? switchMode : undefined} />}
  </>;
}
