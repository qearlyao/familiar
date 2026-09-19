import { useEffect, useState } from "react";
import { fetchDiaries, type DiarySummary } from "@/lib/api";

/** The written days, newest first. `enabled` false holds the fetch until the surface is looked at. */
export function useDiaries(enabled = true) {
  const [diaries, setDiaries] = useState<DiarySummary[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetchDiaries()
      .then((all) => live && setDiaries(all))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [enabled]);

  return { diaries, error, loading };
}
