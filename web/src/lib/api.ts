import type { Attachment, Message, Step, ToolEvent, Usage } from "../types";

interface WireMessage {
  id: string;
  role: "user" | "assistant" | "system";
  who: string;
  steps?: Step[];
  text?: string;
  thinking?: string;
  thinkingMs?: number;
  tools?: ToolEvent[];
  attachments?: Attachment[];
  usage?: Usage;
  silent?: boolean;
  ts: number;
}

function stepId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `step-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function wireToMessage(wire: WireMessage): Message {
  if (wire.steps) {
    return {
      id: wire.id,
      role: wire.role,
      who: wire.who,
      steps: wire.steps,
      attachments: wire.attachments,
      usage: wire.usage,
      silent: wire.silent,
      ts: wire.ts,
    };
  }
  const steps: Step[] = [];
  if (wire.thinking || wire.thinkingMs != null) {
    const endedAt = wire.ts;
    const startedAt = endedAt - (wire.thinkingMs ?? 0);
    steps.push({
      kind: "thinking",
      id: stepId(),
      text: wire.thinking ?? "",
      startedAt,
      endedAt,
      complete: true,
    });
  }
  for (const tool of wire.tools ?? []) {
    steps.push({ kind: "tool", id: tool.id, tool });
  }
  if (wire.text) {
    steps.push({ kind: "text", id: stepId(), text: wire.text, complete: true });
  }
  return {
    id: wire.id,
    role: wire.role,
    who: wire.who,
    steps,
    attachments: wire.attachments,
    usage: wire.usage,
    silent: wire.silent,
    ts: wire.ts,
  };
}

export interface SessionInfo {
  key: string;
  label: string;
  service: "discord";
  scope: "dm" | "channel" | "thread";
  channelId: string;
  channelName?: string;
  threadId?: string;
  isDefault?: boolean;
}

export type StreamEvent =
  | {
      type: "message_started";
      eventId: string;
      ts: number;
      channelKey?: string;
      messageId: string;
      role: "assistant" | "user";
      who: string;
    }
  | {
      type: "delta";
      eventId: string;
      ts: number;
      channelKey?: string;
      messageId: string;
      part: "thinking" | "text";
      content: string;
    }
  | {
      type: "message_completed";
      eventId: string;
      ts: number;
      channelKey?: string;
      messageId: string;
      thinkingMs?: number;
      attachments?: Attachment[];
      silent?: boolean;
      usage?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
      };
    }
  | {
      type: "tool_event";
      eventId: string;
      ts: number;
      channelKey?: string;
      messageId: string;
      tool: ToolEvent;
    }
  | {
      type: "status";
      eventId: string;
      ts: number;
      channelKey?: string;
      kind: "thinking" | "tool" | "idle" | "queued";
      detail?: string;
    }
  | {
      type: "error";
      eventId: string;
      ts: number;
      channelKey?: string;
      code: "rate_limited" | "tool_failed" | "abort" | "unknown";
      message: string;
    }
  | {
      type: "model_error";
      eventId: string;
      ts: number;
      channelKey?: string;
      messageId: string;
      message: string;
    }
  | { type: "replay_window_lost"; eventId: string; ts: number; channelKey?: string };

export type ConnectionState = "connecting" | "open" | "closed" | "error";

export interface HistoryResponse {
  messages: Message[];
  hasMore: boolean;
  channelKey: string;
}

export async function fetchAuthMode(): Promise<{ mode: string; personaName: string }> {
  const res = await fetch("/api/web/auth/mode");
  if (!res.ok) throw new Error(`auth/mode: ${res.status}`);
  const body = (await res.json()) as { mode: string; personaName?: string };
  return { mode: body.mode, personaName: body.personaName ?? "Familiar" };
}

export async function fetchSessions(): Promise<SessionInfo[]> {
  const res = await fetch("/api/web/sessions");
  if (!res.ok) throw new Error(`sessions: ${res.status}`);
  const body = (await res.json()) as { sessions: SessionInfo[] };
  return body.sessions;
}

export async function fetchHistory(channelKey?: string, limit = 50): Promise<HistoryResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (channelKey) params.set("channelKey", channelKey);
  const res = await fetch(`/api/web/history?${params.toString()}`);
  if (!res.ok) throw new Error(`history: ${res.status}`);
  const body = (await res.json()) as { messages: WireMessage[]; hasMore: boolean; channelKey: string };
  return {
    messages: body.messages.map(wireToMessage),
    hasMore: body.hasMore,
    channelKey: body.channelKey,
  };
}

export async function sendMessage(
  text: string,
  clientId: string,
  channelKey?: string,
  attachments: File[] = [],
): Promise<{ id: string; ts: number; channelKey: string }> {
  const body = new FormData();
  body.set("text", text);
  body.set("clientId", clientId);
  if (channelKey) body.set("channelKey", channelKey);
  for (const attachment of attachments) body.append("attachments", attachment, attachment.name);
  const res = await fetch("/api/web/send", { method: "POST", body });
  if (!res.ok) throw new Error(`send: ${res.status}`);
  return (await res.json()) as { id: string; ts: number; channelKey: string };
}

export function streamUrl(channelKey?: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = channelKey ? `?channelKey=${encodeURIComponent(channelKey)}` : "";
  return `${proto}//${window.location.host}/api/web/stream${params}`;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type SettingSource = "config" | "override";

export interface AgentSettings {
  model: { value: string; source: SettingSource };
  thinking: { value: ThinkingLevel; source: SettingSource };
  supportedThinking: ThinkingLevel[];
  persona: { name: string };
}

export async function fetchAgentSettings(channelKey?: string): Promise<AgentSettings> {
  const params = new URLSearchParams();
  if (channelKey) params.set("channelKey", channelKey);
  const res = await fetch(`/api/web/agent/settings${params.toString() ? `?${params.toString()}` : ""}`);
  if (!res.ok) throw new Error(`agent/settings: ${res.status}`);
  return (await res.json()) as AgentSettings;
}

export interface AvailableModels {
  models: string[];
  added: string[];
}

export async function fetchAvailableModels(): Promise<AvailableModels> {
  const res = await fetch("/api/web/agent/models");
  if (!res.ok) throw new Error(`agent/models: ${res.status}`);
  const body = (await res.json()) as AvailableModels;
  return { models: body.models, added: body.added ?? [] };
}

// POST/DELETE with a JSON body; on failure surface the server's {error} string,
// falling back to "<label>: <status>". Returns the parsed body (undefined if empty).
async function jsonRequest<T>(
  url: string,
  method: "POST" | "DELETE",
  body: unknown,
  label: string,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error ?? `${label}: ${res.status}`);
  }
  return (await res.json().catch(() => undefined)) as T;
}

export async function addModel(model: string): Promise<AvailableModels> {
  const body = await jsonRequest<AvailableModels>("/api/web/agent/models", "POST", { model }, "agent/models");
  return { models: body.models, added: body.added ?? [] };
}

export async function removeModel(model: string): Promise<AvailableModels> {
  const body = await jsonRequest<AvailableModels>("/api/web/agent/models", "DELETE", { model }, "agent/models");
  return { models: body.models, added: body.added ?? [] };
}

export async function updateAgentSettings(
  channelKey: string,
  changes: { model?: string; thinking?: ThinkingLevel },
): Promise<AgentSettings> {
  return jsonRequest<AgentSettings>("/api/web/agent/settings", "POST", { channelKey, ...changes }, "agent/settings");
}

export async function startNewChat(channelKey: string): Promise<void> {
  await jsonRequest<void>("/api/web/agent/new", "POST", { channelKey }, "agent/new");
}

export interface Meme {
  name: string;
  url: string;
}

export interface MemeFamily {
  name: string;
  memes: Meme[];
}

export async function fetchMemes(): Promise<MemeFamily[]> {
  const res = await fetch("/api/web/memes");
  if (!res.ok) throw new Error(`memes: ${res.status}`);
  const body = (await res.json()) as { families: MemeFamily[] };
  return body.families;
}

export type ConfigKey =
  | "heartbeat.enabled"
  | "heartbeat.idleThresholdMs"
  | "heartbeat.intervalMs"
  | "memory.lcm.enabled"
  | "memory.lcm.model"
  | "memory.lcm.contextThreshold"
  | "memory.lcm.freshTailCount"
  | "memory.lcm.leafChunkTokens"
  | "memory.lcm.leafTargetTokens"
  | "memory.lcm.condenseGroupSize"
  | "memory.lcm.maxSummaryDepth"
  | "memory.lcm.newSessionRetainDepth"
  | "memory.ambient.enabled"
  | "memory.ambient.topK"
  | "memory.ambient.minQueryLength"
  | "memory.ambient.throttleSeconds"
  | "memory.ambient.weightSimilarity"
  | "memory.ambient.weightValence"
  | "memory.ambient.weightRecency"
  | "memory.ambient.weightIntensity"
  | "image_gen.enabled"
  | "image_gen.model"
  | "image_gen.fallback_model";

export interface ConfigValue<T = unknown> {
  value: T;
  source: SettingSource;
}

export interface ConfigPayload {
  values: {
    "heartbeat.enabled": ConfigValue<boolean>;
    "heartbeat.idleThresholdMs": ConfigValue<number>;
    "heartbeat.intervalMs": ConfigValue<number>;
    "memory.lcm.enabled": ConfigValue<boolean>;
    "memory.lcm.model": ConfigValue<string>;
    "memory.lcm.contextThreshold": ConfigValue<number>;
    "memory.lcm.freshTailCount": ConfigValue<number>;
    "memory.lcm.leafChunkTokens": ConfigValue<number>;
    "memory.lcm.leafTargetTokens": ConfigValue<number>;
    "memory.lcm.condenseGroupSize": ConfigValue<number>;
    "memory.lcm.maxSummaryDepth": ConfigValue<number>;
    "memory.lcm.newSessionRetainDepth": ConfigValue<number>;
    "memory.ambient.enabled": ConfigValue<boolean>;
    "memory.ambient.topK": ConfigValue<number>;
    "memory.ambient.minQueryLength": ConfigValue<number>;
    "memory.ambient.throttleSeconds": ConfigValue<number>;
    "memory.ambient.weightSimilarity": ConfigValue<number>;
    "memory.ambient.weightValence": ConfigValue<number>;
    "memory.ambient.weightRecency": ConfigValue<number>;
    "memory.ambient.weightIntensity": ConfigValue<number>;
    "image_gen.enabled": ConfigValue<boolean>;
    "image_gen.model": ConfigValue<string>;
    "image_gen.fallback_model": ConfigValue<string>;
  };
}

export type ConfigValues = ConfigPayload["values"];

export async function fetchConfig(): Promise<ConfigPayload> {
  const res = await fetch("/api/web/config");
  if (!res.ok) throw new Error(`config: ${res.status}`);
  return (await res.json()) as ConfigPayload;
}

export async function setConfig(key: ConfigKey, value: unknown): Promise<ConfigPayload> {
  return jsonRequest<ConfigPayload>("/api/web/config", "POST", { key, value }, "config");
}

export async function clearConfig(key: ConfigKey): Promise<ConfigPayload> {
  return jsonRequest<ConfigPayload>("/api/web/config", "DELETE", { key }, "config");
}
