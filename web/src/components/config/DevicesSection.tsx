import { useMemo, useState } from "react";
import { logoutAuthSession, revokeAuthDevice, revokeOtherAuthDevices, type WebAuthDevice } from "@/lib/api";
import type { useDevices } from "@/lib/useDevices";
import { cn } from "@/lib/utils";
import { IconX } from "../organicIcons";
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

  return (
    <>
      <div className="settings-column">
        {sorted.map((device) => (
          <article key={device.id} className={cn("device-ticket", device.current && "is-current")}>
            <div>
              <div className="device-name">
                <i />
                <h4>{device.deviceName || "unnamed device"}</h4>
                {device.current && <em>this one</em>}
                {!device.current && (
                  <button
                    type="button"
                    className="device-revoke"
                    aria-label={`revoke ${device.deviceName || "device"}`}
                    title="revoke"
                    disabled={Boolean(busyId)}
                    onClick={() => void run(device.id, async () => { await revokeAuthDevice(device.id); setDevices((prev) => prev.filter((d) => d.id !== device.id)); })}
                  >
                    <IconX />
                    <span>revoke</span>
                  </button>
                )}
              </div>
              <code>
                {device.lastIp ?? "ip unknown"} · {summarizeUserAgent(device.userAgent)}
              </code>
              <span className="device-seen">last seen {when(device.lastSeenAt, (d) => `${day(d)}, ${time(d)}`)}</span>
              <span>
                signed in {when(device.createdAt, day)} · expires {when(device.expiresAt, day)}
              </span>
            </div>
            <div className="device-stub">
              <span>last seen</span>
              <b>{when(device.lastSeenAt, day)}</b>
              <code>{when(device.lastSeenAt, time)}</code>
            </div>
          </article>
        ))}
        {loading && <p className="settings-note">checking devices…</p>}
        {!loading && sorted.length === 0 && <p className="settings-note">no devices found.</p>}
      </div>
      <Card title="signing out">
        <p className="settings-note">signing out the others ends every session but this one. they will need the pairing code again.</p>
        <div className="device-actions">
          <button type="button" className="pill-button" disabled={Boolean(busyId)} onClick={() => void run("current", async () => { await logoutAuthSession(); onSignedOut(); })}>
            log out here
          </button>
          <button
            type="button"
            className="pill-button is-quiet"
            disabled={Boolean(busyId) || others.length === 0}
            onClick={() => void run("others", async () => { await revokeOtherAuthDevices(); setDevices((prev) => prev.filter((d) => d.current)); })}
          >
            sign out the others
          </button>
        </div>
        {error && (
          <p role="alert" className="settings-error">
            {error}
          </p>
        )}
      </Card>
    </>
  );
}
