import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, LoaderCircle, LockKeyhole } from "lucide-react";
import {
  fetchAuthMode,
  fetchAuthSession,
  loginWithBearerToken,
  type WebAuthDevice,
} from "@/lib/api";
import { WebShell } from "./WebShell";
import "./chat.css";
import "./auth-gate.css";

type AuthState =
  | { status: "loading"; personaName: string; mode?: string }
  | { status: "chat"; personaName: string; mode: string; device?: WebAuthDevice }
  | { status: "login"; personaName: string; mode: "bearer"; error?: string };

function browserDeviceHint(): string {
  if (typeof navigator === "undefined") return "";
  const platform = navigator.platform?.trim();
  if (platform) return platform;
  return "this browser";
}

export function AuthGate() {
  const [state, setState] = useState<AuthState>({
    status: "loading",
    personaName: "Familiar",
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const mode = await fetchAuthMode();
        if (mode.mode !== "bearer") {
          if (!cancelled) {
            setState({ status: "chat", mode: mode.mode, personaName: mode.personaName });
          }
          return;
        }

        const device = await fetchAuthSession();
        if (cancelled) return;
        if (device) {
          setState({ status: "chat", mode: "bearer", personaName: mode.personaName, device });
        } else {
          setState({ status: "login", mode: "bearer", personaName: mode.personaName });
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setState({ status: "login", mode: "bearer", personaName: "Familiar", error: message });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "chat") {
    return (
      <WebShell
        personaName={state.personaName}
        authMode={state.mode}
        authDevice={state.device}
        onSignedOut={() => {
          setState({ status: "login", mode: "bearer", personaName: state.personaName });
        }}
      />
    );
  }

  if (state.status === "login") {
    return (
      <BearerLogin
        personaName={state.personaName}
        initialError={state.error}
        onLogin={(device) => {
          setState({ status: "chat", mode: "bearer", personaName: state.personaName, device });
        }}
      />
    );
  }

  return (
    <div className="chat-theme auth-gate">
      <main className="auth-gate-surface auth-gate-loading" aria-busy="true">
        <LoaderCircle size={24} className="auth-gate-spinner" aria-hidden="true" />
        <p role="status">checking the door…</p>
      </main>
    </div>
  );
}

function BearerLogin({
  personaName,
  initialError,
  onLogin,
}: {
  personaName: string;
  initialError: string | undefined;
  onLogin: (device: WebAuthDevice) => void;
}) {
  const [token, setToken] = useState("");
  const [deviceName, setDeviceName] = useState(browserDeviceHint);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(undefined);
    try {
      const device = await loginWithBearerToken(trimmed, deviceName);
      onLogin(device);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-theme auth-gate">
      <main className="auth-gate-surface">
        <header className="auth-gate-brand">
          <span className="auth-gate-monogram" aria-hidden="true">f</span>
          <span>familiar</span>
        </header>
        <div className="auth-gate-content">
          <div className="auth-gate-welcome">
            <div className="auth-gate-avatar" aria-hidden="true">
              {Array.from(personaName)[0] || "F"}
            </div>
            <p className="auth-gate-eyebrow">a little space for you &amp; {personaName}</p>
            <h1>come on in.</h1>
          </div>
          <form onSubmit={submit} className="auth-gate-form" aria-label="Sign in" aria-busy={busy}>
            <div className="auth-gate-form-heading">
              <KeyRound size={20} aria-hidden="true" />
              <h2>your key to the door</h2>
            </div>
            <label className="auth-gate-field">
              <span>access token</span>
              <input
                type="password"
                name="token"
                value={token}
                onChange={(event) => {
                  setToken(event.target.value);
                  if (error) setError(undefined);
                }}
                autoComplete="current-password"
                placeholder="Paste your token here"
                required
                disabled={busy}
                aria-describedby={error ? "auth-gate-error" : undefined}
                className="auth-gate-token"
              />
            </label>
            <label className="auth-gate-field">
              <span>device name</span>
              <input
                type="text"
                name="deviceName"
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                autoComplete="off"
                placeholder="e.g. my laptop"
                disabled={busy}
                aria-describedby="auth-gate-device-hint"
              />
            </label>
            <p id="auth-gate-device-hint" className="auth-gate-hint">A name to recognise this browser in your devices.</p>
            {error ? <p id="auth-gate-error" role="alert" className="auth-gate-error">{error}</p> : null}
            <button type="submit" className="auth-gate-submit" disabled={busy || !token.trim()}>
              <span>{busy ? "checking the key…" : "let’s settle in"}</span>
              {busy ? <LoaderCircle size={18} className="auth-gate-spinner" aria-hidden="true" /> : <ArrowRight size={18} aria-hidden="true" />}
            </button>
          </form>
        </div>
        <footer className="auth-gate-footer"><LockKeyhole size={14} aria-hidden="true" />your space. a key to come in.</footer>
      </main>
    </div>
  );
}
