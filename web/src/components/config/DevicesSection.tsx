import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAuthDevices, logoutAuthSession, revokeAuthDevice, revokeOtherAuthDevices, type WebAuthDevice } from "@/lib/api";
import { cn } from "@/lib/utils";
import { IconX } from "../organicIcons";

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date).toLowerCase();
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

export function DevicesSection({ currentDevice, onSignedOut }: { currentDevice: WebAuthDevice | undefined; onSignedOut: () => void }) {
  const [devices, setDevices] = useState<WebAuthDevice[]>(currentDevice ? [currentDevice] : []);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(() => {
    void fetchAuthDevices()
      .then((next) => {
        setDevices(next);
        setError(undefined);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const id = window.setTimeout(load, 0);
    return () => window.clearTimeout(id);
  }, [load]);

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
      <div className="model-add">
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
      <div className="settings-rows">
        {sorted.map((device) => (
          <div key={device.id} className={cn("device-card", device.current && "is-current")}>
            <div>
              <strong>
                {device.deviceName || "unnamed device"}
                {device.current && <em>this one</em>}
              </strong>
              <span>last seen {formatWhen(device.lastSeenAt)}</span>
              <span>
                made {formatWhen(device.createdAt)} · expires {formatWhen(device.expiresAt)}
              </span>
              <span>
                {device.lastIp ?? "ip unknown"} · {summarizeUserAgent(device.userAgent)}
              </span>
            </div>
            {!device.current && (
              <button
                type="button"
                className="settings-close"
                aria-label={`revoke ${device.deviceName || "device"}`}
                title="revoke"
                disabled={Boolean(busyId)}
                onClick={() => void run(device.id, async () => { await revokeAuthDevice(device.id); setDevices((prev) => prev.filter((d) => d.id !== device.id)); })}
              >
                <IconX />
              </button>
            )}
          </div>
        ))}
        {loading && <p className="settings-note">checking devices…</p>}
        {!loading && sorted.length === 0 && <p className="settings-note">no devices found.</p>}
      </div>
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
    </>
  );
}
