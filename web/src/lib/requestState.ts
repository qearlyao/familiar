import { useCallback, useEffect, useRef, useState } from "react";

export function useIsMounted() {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}

interface RunOptions<T> {
  busy?: "load" | "mutate";
  apply?: (result: T) => void;
  onError?: () => void;
  rethrow?: boolean;
}

export function useRequestState() {
  const alive = useIsMounted();
  const [error, setError] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [isMutating, setIsMutating] = useState(false);

  const run = useCallback(
    async <T>(work: () => Promise<T>, opts: RunOptions<T> = {}): Promise<T | undefined> => {
      const setBusy = opts.busy === "load" ? setIsLoading : setIsMutating;
      setBusy(true);
      setError(undefined);
      try {
        const result = await work();
        if (!alive.current) return undefined;
        opts.apply?.(result);
        return result;
      } catch (err) {
        if (alive.current) {
          opts.onError?.();
          setError(err instanceof Error ? err.message : String(err));
        }
        if (opts.rethrow) throw err;
        return undefined;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [alive],
  );

  return { error, isLoading, isMutating, run };
}
