import { useCallback, useEffect, useMemo, useState } from "react";
import { LogOut, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  fetchAuthDevices,
  logoutAuthSession,
  revokeAuthDevice,
  revokeOtherAuthDevices,
  type WebAuthDevice,
} from "@/lib/api";
import { cn } from "@/lib/utils";

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(date)
    .toLowerCase();
}

function summarizeUserAgent(userAgent: string | undefined): string {
  if (!userAgent) return "browser unknown";
  const browser =
    userAgent.includes("Firefox/")
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

export function DevicesSection({
  currentDevice,
  onSignedOut,
}: {
  currentDevice: WebAuthDevice | undefined;
  onSignedOut: () => void;
}) {
  const [devices, setDevices] = useState<WebAuthDevice[]>(currentDevice ? [currentDevice] : []);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setDevices(await fetchAuthDevices());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
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
  const otherDevices = sorted.filter((device) => !device.current);

  const revoke = async (device: WebAuthDevice) => {
    setBusyId(device.id);
    setError(undefined);
    try {
      await revokeAuthDevice(device.id);
      setDevices((prev) => prev.filter((item) => item.id !== device.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(undefined);
    }
  };

  const signOut = async () => {
    setBusyId("current");
    setError(undefined);
    try {
      await logoutAuthSession();
      onSignedOut();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(undefined);
    }
  };

  const signOutOthers = async () => {
    setBusyId("others");
    setError(undefined);
    try {
      await revokeOtherAuthDevices();
      setDevices((prev) => prev.filter((device) => device.current));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      void load();
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void signOut()}
          disabled={Boolean(busyId)}
          className="gap-2"
        >
          <LogOut className="size-3.5" />
          logout
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void signOutOthers()}
          disabled={Boolean(busyId) || otherDevices.length === 0}
        >
          sign out others
        </Button>
      </div>
      <div className="grid gap-2">
        {sorted.map((device) => (
          <div
            key={device.id}
            className={cn(
              "rounded-md border border-border bg-background px-3 py-2.5",
              device.current && "border-primary/50",
            )}
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="truncate text-sm leading-tight text-foreground">
                    {device.deviceName || "unnamed device"}
                  </p>
                  {device.current ? (
                    <span className="font-serif text-xs italic text-primary">current</span>
                  ) : null}
                </div>
                <p className="mt-1 font-serif text-xs italic text-muted-foreground">
                  last seen {formatWhen(device.lastSeenAt)}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  made {formatWhen(device.createdAt)} · expires {formatWhen(device.expiresAt)}
                </p>
                <p className="mt-1 truncate text-xs text-muted-foreground/80">
                  {device.lastIp ?? "ip unknown"} · {summarizeUserAgent(device.userAgent)}
                </p>
              </div>
              {!device.current ? (
                <button
                  type="button"
                  aria-label={`revoke ${device.deviceName || "device"}`}
                  title="revoke"
                  disabled={Boolean(busyId)}
                  onClick={() => void revoke(device)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
                >
                  <Trash2 className="size-4" />
                </button>
              ) : null}
            </div>
          </div>
        ))}
        {loading ? (
          <p className="font-serif text-xs italic text-muted-foreground">checking devices…</p>
        ) : null}
        {!loading && sorted.length === 0 ? (
          <p className="font-serif text-xs italic text-muted-foreground">no devices found.</p>
        ) : null}
      </div>
      {error ? <p className="font-serif text-xs italic text-destructive">{error}</p> : null}
    </div>
  );
}
