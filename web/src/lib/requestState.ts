import { useCallback, useState } from "react";

interface RunOptions<T> {
  busy?: "load" | "mutate";
  apply?: (result: T) => void;
  onError?: () => void;
  rethrow?: boolean;
}

export function useRequestState() {
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
        opts.apply?.(result);
        return result;
      } catch (err) {
        opts.onError?.();
        setError(err instanceof Error ? err.message : String(err));
        if (opts.rethrow) throw err;
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return { error, isLoading, isMutating, run };
}
