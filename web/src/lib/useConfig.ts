import { useCallback, useEffect, useState } from "react";
import {
  clearConfig as apiClearConfig,
  fetchConfig,
  setConfig as apiSetConfig,
  type ConfigKey,
  type ConfigPayload,
} from "./api";
import { useRequestState } from "./requestState";

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
  const { error, isLoading, isMutating, run } = useRequestState();

  const load = useCallback(async () => {
    if (!enabled) return;
    await run(() => fetchConfig(), { busy: "load", apply: setData });
  }, [enabled, run]);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const setConfig = useCallback(
    async (key: ConfigKey, value: unknown) => {
      await run(() => apiSetConfig(key, value), { apply: setData, rethrow: true });
    },
    [run],
  );

  const clearConfig = useCallback(
    async (key: ConfigKey) => {
      await run(() => apiClearConfig(key), { apply: setData, rethrow: true });
    },
    [run],
  );

  return { data, error, isLoading, isMutating, setConfig, clearConfig, refetch: load };
}
