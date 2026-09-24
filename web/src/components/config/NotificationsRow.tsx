import { useEffect, useState } from "react";
import { NOTIFICATIONS_CHANGED_EVENT, notificationState, setNotificationsEnabled, type NotificationState } from "@/lib/notifications";
import { OnOffToggle, Row } from "./inputs";

const blocked: Partial<Record<NotificationState, string>> = {
  denied: "blocked for this site — allow them in the browser first",
  unsupported: window.isSecureContext
    ? "on iphone or ipad, add the app to your home screen first"
    : "notifications need an https address — plain http can't carry them",
};

/** "notify this device", as one row among the ways they reach you. */
export function NotificationsRow() {
  const [state, setState] = useState<NotificationState | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    const refresh = () => {
      void notificationState().then(setState);
    };
    refresh();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
  }, []);
  if (!state) return null;
  return (
    <Row label="notify this device" help={error ? `that didn't take — ${error}` : blocked[state]}>
      {!blocked[state] && (
        <OnOffToggle
          enabled={state === "on"}
          disabled={busy}
          ariaPrefix="notifications"
          onChange={(next) => {
            setBusy(true);
            setError(undefined);
            void setNotificationsEnabled(next)
              .then(setState, (cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
                return notificationState().then(setState);
              })
              .finally(() => setBusy(false));
          }}
        />
      )}
    </Row>
  );
}
