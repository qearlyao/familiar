import { useCallback, useEffect, useRef, useState } from "react";
import {
  addModel as apiAddModel,
  fetchAgentSettings,
  fetchAvailableModels,
  removeModel as apiRemoveModel,
  updateAgentSettings,
  type AgentSettings,
  type ThinkingLevel,
} from "./api";

export interface UseAgentSettings {
  data: AgentSettings | undefined;
  models: string[];
  addedModels: string[];
  error: string | undefined;
  isLoading: boolean;
  isMutating: boolean;
  setModel: (model: string) => Promise<void>;
  setThinking: (thinking: ThinkingLevel) => Promise<void>;
  addModel: (model: string) => Promise<void>;
  removeModel: (model: string) => Promise<void>;
  refetch: () => Promise<void>;
}

export function useAgentSettings(channelKey: string | undefined): UseAgentSettings {
  const [data, setData] = useState<AgentSettings | undefined>(undefined);
  const [models, setModels] = useState<string[]>([]);
  const [addedModels, setAddedModels] = useState<string[]>([]);
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
      setModels(modelList.models);
      setAddedModels(modelList.added);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setIsLoading(false);
    }
  }, [channelKey]);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
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

  const addModel = useCallback(async (model: string) => {
    setIsMutating(true);
    setError(undefined);
    try {
      const next = await apiAddModel(model);
      if (!aliveRef.current) return;
      setModels(next.models);
      setAddedModels(next.added);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (aliveRef.current) setIsMutating(false);
    }
  }, []);

  const removeModel = useCallback(async (model: string) => {
    setIsMutating(true);
    setError(undefined);
    try {
      const next = await apiRemoveModel(model);
      if (!aliveRef.current) return;
      setModels(next.models);
      setAddedModels(next.added);
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
    models,
    addedModels,
    error,
    isLoading,
    isMutating,
    setModel,
    setThinking,
    addModel,
    removeModel,
    refetch: load,
  };
}
