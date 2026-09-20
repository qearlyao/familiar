import { useEffect } from "react";

/**
 * Keeps the phone screen from sleeping while a call is live.
 *
 * The lock is dropped by the browser whenever the page is hidden — switching
 * tabs, or the screen going off before we asked — so it is taken again on every
 * return to visibility for as long as the caller wants it held.
 */
export function useScreenWakeLock(hold: boolean): void {
  useEffect(() => {
    if (!hold || !navigator.wakeLock) return;
    let sentinel: WakeLockSentinel | null = null;
    let dropped = false;

    const take = () => {
      if (dropped || sentinel || document.visibilityState !== "visible") return;
      void navigator.wakeLock
        .request("screen")
        .then((next) => {
          if (dropped) {
            void next.release().catch(() => undefined);
            return;
          }
          sentinel = next;
          next.addEventListener("release", () => {
            if (sentinel === next) sentinel = null;
          });
        })
        // a denied lock is never worth breaking the call over: battery saver and
        // backgrounded tabs both refuse, and the call itself carries on fine
        .catch(() => undefined);
    };

    take();
    document.addEventListener("visibilitychange", take);
    return () => {
      dropped = true;
      document.removeEventListener("visibilitychange", take);
      void sentinel?.release().catch(() => undefined);
      sentinel = null;
    };
  }, [hold]);
}
