import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAgentSettings,
  fetchAvailableModels,
  updateAgentSettings,
  type AgentSettings,
  type ThinkingLevel,
} from "./api";

export interface UseAgentSettings {
  data: AgentSettings | undefined;
  models: string[];
  error: string | undefined;
  isLoading: boolean;
  isMutating: boolean;
  setModel: (model: string) => Promise<void>;
  setThinking: (thinking: ThinkingLevel) => Promise<void>;
  refetch: () => Promise<void>;
}

export function useAgentSettings(channelKey: string | undefined): UseAgentSettings {
  const [data, setData] = useState<AgentSettings | undefined>(undefined);
  const [models, setModels] = useState<string[]>([]);
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
    if (!channelKey) return;
    setIsLoading(true);
    setError(undefined);
    try {
      const [settings, modelList] = await Promise.all([
        fetchAgentSettings(channelKey),
        fetchAvailableModels(),
      ]);
      if (!aliveRef.current) return;
      setData(settings);
      setModels(modelList);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setIsLoading(false);
    }
  }, [channelKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (changes: { model?: string; thinking?: ThinkingLevel }) => {
      if (!channelKey) return;
      const previous = data;
      const optimistic: AgentSettings | undefined = previous
        ? {
            ...previous,
            model: changes.model
              ? { value: changes.model, source: "override" }
              : previous.model,
            thinking: changes.thinking
              ? { value: changes.thinking, source: "override" }
              : previous.thinking,
          }
        : previous;
      if (optimistic) setData(optimistic);
      setIsMutating(true);
      setError(undefined);
      try {
        const next = await updateAgentSettings(channelKey, changes);
        if (!aliveRef.current) return;
        setData(next);
      } catch (err) {
        if (!aliveRef.current) return;
        if (previous) setData(previous);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (aliveRef.current) setIsMutating(false);
      }
    },
    [channelKey, data],
  );

  const setModel = useCallback((model: string) => mutate({ model }), [mutate]);
  const setThinking = useCallback((thinking: ThinkingLevel) => mutate({ thinking }), [mutate]);

  return { data, models, error, isLoading, isMutating, setModel, setThinking, refetch: load };
}
