import { useEffect, useState, type FormEvent } from "react";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  fetchAuthMode,
  fetchAuthSession,
  loginWithBearerToken,
  type WebAuthDevice,
} from "@/lib/api";
import { WebShell } from "./WebShell";

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
    <div className="flex h-dvh items-center justify-center bg-background px-5 text-foreground antialiased">
      <p className="font-serif text-sm italic text-muted-foreground">checking the door…</p>
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
    <div className="flex h-dvh flex-col bg-background text-foreground antialiased">
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-5 py-10">
        <form onSubmit={submit} className="rounded-md border border-border bg-card px-5 py-5 shadow-sm">
          <div className="mb-5">
            <p className="font-serif text-2xl leading-tight tracking-tight">{personaName}</p>
            <p className="mt-2 font-serif text-xs italic text-muted-foreground">come in with your token.</p>
          </div>
          <label className="grid gap-2">
            <span className="font-serif text-xs italic text-muted-foreground">token</span>
            <input
              type="password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                if (error) setError(undefined);
              }}
              autoComplete="current-password"
              disabled={busy}
              className="h-10 rounded-md border border-border bg-background px-3 font-mono text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
            />
          </label>
          <label className="mt-4 grid gap-2">
            <span className="font-serif text-xs italic text-muted-foreground">device name</span>
            <input
              type="text"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              autoComplete="off"
              disabled={busy}
              className="h-10 rounded-md border border-border bg-background px-3 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
            />
          </label>
          {error ? <p className="mt-3 font-serif text-xs italic text-destructive">{error}</p> : null}
          <Button type="submit" className="mt-5 h-9 w-full gap-2" disabled={busy || !token.trim()}>
            <LogIn className="size-4" />
            <span>{busy ? "checking" : "enter"}</span>
          </Button>
        </form>
      </main>
    </div>
  );
}
