import { useEffect, useState } from "react";
import { fetchAuthDevices, type WebAuthDevice } from "./api";

/** Held by the settings surface, so the devices tab can say how many are signed in before it opens. */
export function useDevices(enabled: boolean, currentDevice: WebAuthDevice | undefined) {
  const [devices, setDevices] = useState<WebAuthDevice[]>(currentDevice ? [currentDevice] : []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!enabled) return;
    const id = window.setTimeout(() => {
      void fetchAuthDevices()
        .then((next) => {
          setDevices(next);
          setError(undefined);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(id);
  }, [enabled]);

  return { devices, setDevices, loading, error, setError };
}
