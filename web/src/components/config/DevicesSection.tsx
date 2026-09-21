import { useMemo, useState } from "react";
import { logoutAuthSession, revokeAuthDevice, revokeOtherAuthDevices, type WebAuthDevice } from "@/lib/api";
import type { useDevices } from "@/lib/useDevices";
import { cn } from "@/lib/utils";
import { Card } from "./inputs";

const day = (date: Date) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date).toLowerCase();
const time = (date: Date) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date).toLowerCase();

function when(value: string, format: (date: Date) => string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : format(date);
}

function summarizeUserAgent(userAgent: string | undefined): string {
  if (!userAgent) return "browser unknown";
  const browser = userAgent.includes("Firefox/")
    ? "firefox"
    : userAgent.includes("Edg/")
      ? "edge"
      : userAgent.includes("Chrome/")
        ? "chrome"
        : userAgent.includes("Safari/")
          ? "safari"
          : "browser";
  const os =
    userAgent.includes("iPhone") || userAgent.includes("iPad")
      ? "ios"
      : userAgent.includes("Mac OS X")
        ? "mac"
        : userAgent.includes("Windows")
          ? "windows"
          : userAgent.includes("Linux")
            ? "linux"
            : undefined;
  return os ? `${browser} on ${os}` : browser;
}

function deviceSortValue(device: WebAuthDevice): number {
  const date = new Date(device.lastSeenAt);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export function DevicesSection({ state, onSignedOut }: { state: ReturnType<typeof useDevices>; onSignedOut: () => void }) {
  const { devices, setDevices, loading, error, setError } = state;
  const [busyId, setBusyId] = useState<string | undefined>();

  const sorted = useMemo(
    () =>
      [...devices].sort((a, b) => {
        if (a.current && !b.current) return -1;
        if (!a.current && b.current) return 1;
        return deviceSortValue(b) - deviceSortValue(a);
      }),
    [devices],
  );
  const others = sorted.filter((device) => !device.current);

  const run = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(undefined);
    }
  };

  /* Two surfaces, CSS picks one: a phone has no room for the line, so there the actions ride on the tickets. */
  const logOutHere = () => void run("current", async () => { await logoutAuthSession(); onSignedOut(); });
  const signOutOthers = () => void run("others", async () => { await revokeOtherAuthDevices(); setDevices((prev) => prev.filter((d) => d.current)); });

  return (
    <Card
      title="signed in"
      hint="browsers holding a session. signing out the others ends every one but this."
      action={
        <button type="button" className="pill-button is-quiet" disabled={Boolean(busyId) || others.length === 0} title="they will need the pairing code again" onClick={signOutOthers}>
          sign out the others
        </button>
      }
    >
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
      <div className="settings-rows">
        {sorted.map((device) => (
          <div key={device.id} className={cn("settings-row device-row", device.current && "is-current")}>
            <div className="settings-row-label">
              <span>
                <i />
                {device.deviceName || "unnamed device"}
                {device.current && <em>this one</em>}
              </span>
              <small>
                {summarizeUserAgent(device.userAgent)} · {device.lastIp ?? "ip unknown"} · last seen {when(device.lastSeenAt, (d) => `${day(d)}, ${time(d)}`)}
              </small>
              <small>
                signed in {when(device.createdAt, day)} · expires {when(device.expiresAt, day)}
              </small>
            </div>
            <div className="settings-row-control">
              {device.current ? (
                <button type="button" className="pill-button is-quiet" disabled={Boolean(busyId)} onClick={logOutHere}>
                  log out
                </button>
              ) : (
                <button
                  type="button"
                  className="pill-button is-quiet"
                  disabled={Boolean(busyId)}
                  onClick={() => void run(device.id, async () => { await revokeAuthDevice(device.id); setDevices((prev) => prev.filter((d) => d.id !== device.id)); })}
                >
                  revoke
                </button>
              )}
            </div>
          </div>
        ))}
        {loading && <p className="settings-note">checking devices…</p>}
        {!loading && sorted.length === 0 && <p className="settings-note">no devices found.</p>}
      </div>
    </Card>
  );
}
