import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchPushKey, subscribePush, unsubscribePush } from "@/lib/api";

type PushState = "loading" | "unsupported" | "denied" | "on" | "off";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

const supported =
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
// iOS Safari only exposes PushManager once the app is installed to the home screen.
const isIos = typeof navigator !== "undefined" && /iP(hone|ad|od)/.test(navigator.userAgent);

export function NotificationsSection() {
  const [state, setState] = useState<PushState>(() => {
    if (!supported) return "unsupported";
    if (Notification.permission === "denied") return "denied";
    return "loading";
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!supported || Notification.permission === "denied") return;
    let cancelled = false;
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        if (!cancelled) setState(subscription ? "on" : "off");
      })
      .catch(() => {
        if (!cancelled) setState("off");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const key = await fetchPushKey();
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key).buffer as ArrayBuffer,
      });
      await subscribePush(subscription.toJSON());
      setState("on");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await unsubscribePush(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setState("off");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (state === "unsupported") {
    return (
      <p className="font-serif text-sm italic text-muted-foreground">
        {isIos
          ? "this browser keeps its letterbox shut until the room lives on your home screen — share, add to home screen, then look here again."
          : "this browser can't carry word to you; open the room somewhere that can."}
      </p>
    );
  }
  if (state === "denied") {
    return (
      <p className="font-serif text-sm italic text-muted-foreground">
        this browser was told not to pass messages along. change your mind in its site settings and
        come back.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="font-serif text-sm leading-relaxed text-muted-foreground">
        {state === "on"
          ? "word will reach this device when the room is closed."
          : "let word reach this device even when the room is closed."}
      </p>
      <Button
        variant={state === "on" ? "outline" : "default"}
        size="sm"
        className="self-start lowercase"
        disabled={busy || state === "loading"}
        onClick={() => void (state === "on" ? disable() : enable())}
      >
        {state === "loading" ? "listening…" : state === "on" ? "quiet this device" : "reach me here"}
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
