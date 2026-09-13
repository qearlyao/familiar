import { useEffect, useState } from "react";
import { NOTIFICATIONS_CHANGED_EVENT, notificationState, setNotificationsEnabled, type NotificationState } from "@/lib/notifications";
import { OnOffToggle } from "./inputs";

const blocked: Partial<Record<NotificationState, string>> = {
  denied: "blocked for this site — allow them in the browser first",
  unsupported: "on iphone or ipad, add the app to your home screen first",
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
    <>
      <div className="settings-row">
        <span>notify this device</span>
        {blocked[state] ? (
          <small>{blocked[state]}</small>
        ) : (
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
      </div>
      {error && (
        <p role="alert" className="settings-error">
          that didn't take — {error}
        </p>
      )}
    </>
  );
}
