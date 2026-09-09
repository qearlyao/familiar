import { useEffect, useState } from "react";
import { NOTIFICATIONS_CHANGED_EVENT, notificationState, setNotificationsEnabled, type NotificationState } from "@/lib/notifications";
import { OnOffToggle } from "./inputs";

const hints: Record<NotificationState, string> = {
  on: "a word from this device when a message lands while you're away. if discord already reaches you here, leave this off to avoid hearing it twice.",
  off: "a word from this device when a message lands while you're away. if discord already reaches you here, leave this off to avoid hearing it twice.",
  denied: "the browser has notifications blocked for this site — allow them in its settings first.",
  unsupported: "this browser can't show notifications. on iphone or ipad, add the app to your home screen first.",
};

export function NotificationsSection() {
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
    <div className="settings-card">
      <div className="settings-card-head">
        <div className="settings-block-title">
          <span>notifications</span>
          <span>{hints[state]}</span>
        </div>
        {(state === "on" || state === "off") && (
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
    </div>
  );
}
