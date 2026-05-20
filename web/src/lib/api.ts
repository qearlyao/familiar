import type { Message } from "../types";

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
      attachments?: Message["attachments"];
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
      tool: NonNullable<Message["tools"]>[number];
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
  return (await res.json()) as HistoryResponse;
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

export async function addModel(model: string): Promise<AvailableModels> {
  const res = await fetch("/api/web/agent/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `agent/models: ${res.status}`);
  }
  const body = (await res.json()) as AvailableModels;
  return { models: body.models, added: body.added ?? [] };
}

export async function removeModel(model: string): Promise<AvailableModels> {
  const res = await fetch("/api/web/agent/models", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `agent/models: ${res.status}`);
  }
  const body = (await res.json()) as AvailableModels;
  return { models: body.models, added: body.added ?? [] };
}

export async function updateAgentSettings(
  channelKey: string,
  changes: { model?: string; thinking?: ThinkingLevel },
): Promise<AgentSettings> {
  const res = await fetch("/api/web/agent/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelKey, ...changes }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `agent/settings: ${res.status}`);
  }
  return (await res.json()) as AgentSettings;
}

export async function startNewChat(channelKey: string): Promise<void> {
  const res = await fetch("/api/web/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelKey }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `agent/new: ${res.status}`);
  }
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
