import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearConfig as apiClearConfig,
  fetchConfig,
  setConfig as apiSetConfig,
  type ConfigKey,
  type ConfigPayload,
} from "./api";

export interface UseConfig {
  data: ConfigPayload | undefined;
  error: string | undefined;
  isLoading: boolean;
  isMutating: boolean;
  setConfig: (key: ConfigKey, value: unknown) => Promise<void>;
  clearConfig: (key: ConfigKey) => Promise<void>;
  refetch: () => Promise<void>;
}

export function useConfig(enabled: boolean): UseConfig {
  const [data, setData] = useState<ConfigPayload | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!enabled) return;
    setIsLoading(true);
    setError(undefined);
    try {
      const next = await fetchConfig();
      if (!aliveRef.current) return;
      setData(next);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setIsLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const setConfig = useCallback(async (key: ConfigKey, value: unknown) => {
    setIsMutating(true);
    setError(undefined);
    try {
      const next = await apiSetConfig(key, value);
      if (!aliveRef.current) return;
      setData(next);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (aliveRef.current) setIsMutating(false);
    }
  }, []);

  const clearConfig = useCallback(async (key: ConfigKey) => {
    setIsMutating(true);
    setError(undefined);
    try {
      const next = await apiClearConfig(key);
      if (!aliveRef.current) return;
      setData(next);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (aliveRef.current) setIsMutating(false);
    }
  }, []);

  return {
    data,
    error,
    isLoading,
    isMutating,
    setConfig,
    clearConfig,
    refetch: load,
  };
}
