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
): Promise<{ id: string; ts: number; channelKey: string }> {
  const res = await fetch("/api/web/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, clientId, channelKey }),
  });
  if (!res.ok) throw new Error(`send: ${res.status}`);
  return (await res.json()) as { id: string; ts: number; channelKey: string };
}

export function streamUrl(channelKey?: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = channelKey ? `?channelKey=${encodeURIComponent(channelKey)}` : "";
  return `${proto}//${window.location.host}/api/web/stream${params}`;
}
