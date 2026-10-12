import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PublicClientApplication, type AccountInfo } from "@azure/msal-browser";
import { MsalProvider } from "@azure/msal-react";
import { api, setTokenProvider } from "./api";
import "./styles.css";
const App = React.lazy(() => import("./Workspace"));
function Bootstrap() {
  const [config, setConfig] = useState<any>();
  const [error, setError] = useState("");
  const [client, setClient] = useState<PublicClientApplication>();
  const [account, setAccount] = useState<AccountInfo>();
  const [identity, setIdentity] = useState<{ id: string; roles: string[] }>();
  useEffect(() => {
    api("/config")
      .then(async (c) => {
        setConfig(c);
        if (c.devAuth) { setIdentity(await api("/me")); return; }
        if (!c.tenantId || !c.clientId || !c.scope) return;
        const instance = new PublicClientApplication({
          auth: {
            clientId: c.clientId,
            authority: `https://login.microsoftonline.com/${c.tenantId}`,
            redirectUri: location.origin,
          },
          cache: { cacheLocation: "sessionStorage" },
        });
        await instance.initialize();
        await instance.handleRedirectPromise();
        const a = instance.getAllAccounts()[0];
        setClient(instance);
        setAccount(a);
        setTokenProvider(async () => {
          if (!a) throw new Error("Sign in required");
          return (
            await instance.acquireTokenSilent({ scopes: [c.scope], account: a })
          ).accessToken;
        });
        if (a) setIdentity(await api("/me"));
      })
      .catch((e) => setError(e.message));
  }, []);
  if (config?.devAuth && identity) return <App user="Local developer" roles={identity.roles} development />;
  if (client && account && identity) {
    return (
      <MsalProvider instance={client}>
        <App
          user={account.name ?? account.username}
          roles={identity.roles}
          onSignOut={() => client.logoutRedirect()}
        />
      </MsalProvider>
    );
  }
  return (
    <main className="login">
      <div className="login-card">
        <img className="brand-mark" src="/branding/barista-icon-192.png" alt="" width="47" height="47" />
        <h1>Barista Labels</h1>
        <p>A familiar workspace for precision labels.</p>
        {error && <div className="alert alert-error">{error}</div>}
        {!config ? (
          <p>Connecting to the label server…</p>
        ) : !client ? (
          <div className="alert">
            Microsoft Entra API configuration is required. Set the API audience
            and delegated scope on the server. For local development, explicitly
            enable BARISTA_DEV_AUTH on a loopback server.
          </div>
        ) : (
          <button
            className="btn btn-primary"
            onClick={() => client.loginRedirect({ scopes: [config.scope] })}
          >
            Sign in with Microsoft
          </button>
        )}
        <small>Projects · Label design · Zebra network printing</small>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <React.Suspense
      fallback={<main className="login">Loading label workspace…</main>}
    >
      <Bootstrap />
    </React.Suspense>
  </React.StrictMode>,
);
