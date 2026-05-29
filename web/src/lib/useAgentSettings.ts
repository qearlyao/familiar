import { useCallback, useEffect, useState } from "react";
import {
  addModel as apiAddModel,
  fetchAgentSettings,
  fetchAvailableModels,
  removeModel as apiRemoveModel,
  updateAgentSettings,
  type AgentSettings,
  type ThinkingLevel,
} from "./api";
import { useRequestState } from "./requestState";

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
  const { error, isLoading, isMutating, run } = useRequestState();

  const load = useCallback(async () => {
    if (!channelKey) return;
    await run(() => Promise.all([fetchAgentSettings(channelKey), fetchAvailableModels()]), {
      busy: "load",
      apply: ([settings, modelList]) => {
        setData(settings);
        setModels(modelList.models);
        setAddedModels(modelList.added);
      },
    });
  }, [channelKey, run]);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const mutate = useCallback(
    async (changes: { model?: string; thinking?: ThinkingLevel }) => {
      if (!channelKey) return;
      const previous = data;
      if (previous) {
        setData({
          ...previous,
          model: changes.model ? { value: changes.model, source: "override" } : previous.model,
          thinking: changes.thinking
            ? { value: changes.thinking, source: "override" }
            : previous.thinking,
        });
      }
      await run(() => updateAgentSettings(channelKey, changes), {
        apply: setData,
        onError: () => {
          if (previous) setData(previous);
        },
      });
    },
    [channelKey, data, run],
  );

  const setModel = useCallback((model: string) => mutate({ model }), [mutate]);
  const setThinking = useCallback((thinking: ThinkingLevel) => mutate({ thinking }), [mutate]);

  const addModel = useCallback(
    async (model: string) => {
      await run(() => apiAddModel(model), {
        apply: (next) => {
          setModels(next.models);
          setAddedModels(next.added);
        },
        rethrow: true,
      });
    },
    [run],
  );

  const removeModel = useCallback(
    async (model: string) => {
      await run(() => apiRemoveModel(model), {
        apply: (next) => {
          setModels(next.models);
          setAddedModels(next.added);
        },
        rethrow: true,
      });
    },
    [run],
  );

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
