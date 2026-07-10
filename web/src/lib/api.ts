import type { Attachment, Message, Step, ToolEvent, Usage } from "../types";
import type { ControlCommand } from "@/lib/slashCommands";

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
  context?: { tokens: number; limit: number };
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
      type: "message_replaced";
      eventId: string;
      ts: number;
      channelKey?: string;
      oldMessageId: string;
      newMessageId: string;
    }
  | {
      type: "message_deleted";
      eventId: string;
      ts: number;
      channelKey?: string;
      messageId: string;
    }
  | {
      type: "message_edited";
      eventId: string;
      ts: number;
      channelKey?: string;
      messageId: string;
      text: string;
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

export type StreamFrame = StreamEvent | { type: "pong"; ts: number };

export type ConnectionState = "connecting" | "open" | "closed" | "error";

export interface HistoryResponse {
  messages: Message[];
  hasMore: boolean;
  channelKey: string;
}

export interface DiarySummary {
  date: string;
  sourceId: string;
  title: string;
  excerpt: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface DiaryEntry extends DiarySummary {
  content: string;
}

export const WEB_FILE_IDS = ["soul", "user", "memory", "heartbeat", "contact"] as const;
export type WebFileId = (typeof WEB_FILE_IDS)[number];

export interface WebFileSummary {
  id: WebFileId;
  name: string;
  title: string;
  description: string;
  mtimeMs: number | null;
  sizeBytes: number;
  exists: boolean;
}

export interface WebFileEntry extends WebFileSummary {
  content: string;
}

export interface GalleryItem {
  id: string;
  name: string;
  kind: "image" | "audio";
  mimeType?: string;
  size?: number;
  url: string;
  createdAt: number;
  note: string;
}

export async function fetchGallery(): Promise<GalleryItem[]> {
  const res = await fetch("/api/web/gallery");
  if (!res.ok) throw new Error(`gallery: ${res.status}`);
  const body = (await res.json()) as { items: GalleryItem[] };
  return body.items;
}

export async function saveGalleryNote(id: string, note: string): Promise<string> {
  const body = await jsonRequest<{ note: string }>("/api/web/gallery/note", "PUT", { id, note }, "gallery/note");
  return body.note;
}

export interface WebSkillSummary {
  id: string;
  name: string;
  description: string;
  relativePath: string;
  mtimeMs: number;
  sizeBytes: number;
  enabled: boolean;
  diagnostics: string[];
}

export interface WebSkillEntry extends WebSkillSummary {
  content: string;
}

export async function fetchAuthMode(): Promise<{ mode: string; personaName: string }> {
  const res = await fetch("/api/web/auth/mode");
  if (!res.ok) throw new Error(`auth/mode: ${res.status}`);
  const body = (await res.json()) as { mode: string; personaName?: string };
  return { mode: body.mode, personaName: body.personaName ?? "Familiar" };
}

export interface WebAuthDevice {
  id: string;
  deviceName: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  lastIp?: string;
  userAgent?: string;
  current?: boolean;
}

export async function fetchAuthSession(): Promise<WebAuthDevice | undefined> {
  const res = await fetch("/api/web/auth/session");
  if (res.status === 401) return undefined;
  if (!res.ok) throw new Error(`auth/session: ${res.status}`);
  const body = (await res.json()) as { device: WebAuthDevice };
  return body.device;
}

export async function loginWithBearerToken(
  token: string,
  deviceName?: string,
): Promise<WebAuthDevice> {
  const body = await jsonRequest<{ device: WebAuthDevice }>(
    "/api/web/auth/login",
    "POST",
    { token, deviceName: deviceName?.trim() || undefined },
    "auth/login",
  );
  return body.device;
}

export async function fetchAuthDevices(): Promise<WebAuthDevice[]> {
  const res = await fetch("/api/web/auth/devices");
  if (!res.ok) throw new Error(`auth/devices: ${res.status}`);
  const body = (await res.json()) as { devices: WebAuthDevice[] };
  return body.devices;
}

export async function revokeAuthDevice(id: string): Promise<void> {
  await jsonRequest<{ ok: true }>("/api/web/auth/devices", "DELETE", { id }, "auth/devices");
}

export async function revokeOtherAuthDevices(): Promise<number> {
  const body = await jsonRequest<{ ok: true; revoked: number }>(
    "/api/web/auth/devices/revoke-others",
    "POST",
    {},
    "auth/devices/revoke-others",
  );
  return body.revoked;
}

export async function logoutAuthSession(): Promise<void> {
  await jsonRequest<{ ok: true }>("/api/web/auth/logout", "POST", {}, "auth/logout");
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

export async function fetchDiaries(): Promise<DiarySummary[]> {
  const res = await fetch("/api/web/diaries");
  if (!res.ok) throw new Error(`diaries: ${res.status}`);
  const body = (await res.json()) as { diaries: DiarySummary[] };
  return body.diaries;
}

export async function fetchDiary(date: string): Promise<DiaryEntry> {
  const params = new URLSearchParams({ date });
  const res = await fetch(`/api/web/diary?${params.toString()}`);
  if (!res.ok) throw new Error(`diary: ${res.status}`);
  const body = (await res.json()) as { diary: DiaryEntry };
  return body.diary;
}

export async function fetchFiles(): Promise<WebFileSummary[]> {
  const res = await fetch("/api/web/files");
  if (!res.ok) throw new Error(`files: ${res.status}`);
  const body = (await res.json()) as { files: WebFileSummary[] };
  return body.files;
}

export async function fetchFile(id: WebFileId): Promise<WebFileEntry> {
  const params = new URLSearchParams({ id });
  const res = await fetch(`/api/web/file?${params.toString()}`);
  if (!res.ok) throw new Error(`file: ${res.status}`);
  const body = (await res.json()) as { file: WebFileEntry };
  return body.file;
}

export async function saveFile(id: WebFileId, content: string): Promise<WebFileEntry> {
  const body = await jsonRequest<{ file: WebFileEntry }>("/api/web/file", "PUT", { id, content }, "file");
  return body.file;
}

export async function fetchSkills(): Promise<WebSkillSummary[]> {
  const res = await fetch("/api/web/skills");
  if (!res.ok) throw new Error(`skills: ${res.status}`);
  const body = (await res.json()) as { skills: WebSkillSummary[] };
  return body.skills;
}

export async function fetchSkill(id: string): Promise<WebSkillEntry> {
  const params = new URLSearchParams({ id });
  const res = await fetch(`/api/web/skill?${params.toString()}`);
  if (!res.ok) throw new Error(`skill: ${res.status}`);
  const body = (await res.json()) as { skill: WebSkillEntry };
  return body.skill;
}

export async function saveSkill(
  id: string,
  draft: { name: string; description: string; enabled: boolean; content: string },
): Promise<WebSkillEntry> {
  const body = await jsonRequest<{ skill: WebSkillEntry }>("/api/web/skill", "PUT", { id, ...draft }, "skill");
  return body.skill;
}

export async function setSkillEnabled(id: string, enabled: boolean): Promise<WebSkillEntry> {
  const body = await jsonRequest<{ skill: WebSkillEntry }>(
    "/api/web/skill/enabled",
    "PUT",
    { id, enabled },
    "skill/enabled",
  );
  return body.skill;
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
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error ?? `send: ${res.status}`);
  }
  return (await res.json()) as { id: string; ts: number; channelKey: string };
}

export async function sendControlCommand(
  command: ControlCommand,
  args: string,
  channelKey?: string,
): Promise<{ message: string; channelKey: string }> {
  const res = await fetch("/api/web/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, args, channelKey }),
  });
  const body = await res.json().catch(() => undefined);
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const message = typeof record?.message === "string" ? record.message : undefined;
  const channel = typeof record?.channelKey === "string" ? record.channelKey : undefined;
  const error = typeof record?.error === "string" ? record.error : message;
  if (!res.ok || record?.ok === false) {
    throw new Error(error ?? `control: ${res.status}`);
  }
  if (record?.ok !== true || message === undefined || channel === undefined) {
    throw new Error("control: invalid response");
  }
  return { message, channelKey: channel };
}

export function streamUrl(channelKey?: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = channelKey ? `?channelKey=${encodeURIComponent(channelKey)}` : "";
  return `${proto}//${window.location.host}/api/web/stream${params}`;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  method: "POST" | "PUT" | "DELETE",
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

export type LatestAssistantControlAction = "retry" | "delete";
export type LatestAssistantAction = LatestAssistantControlAction | "edit";

export async function sendLatestAssistantAction(
  action: LatestAssistantControlAction,
  channelKey?: string,
): Promise<void> {
  const path = action === "retry" ? "/api/web/retry" : "/api/web/delete";
  await jsonRequest<void>(path, "POST", { channelKey }, action);
}

export async function editLatestAssistant(text: string, channelKey?: string): Promise<void> {
  await jsonRequest<void>("/api/web/edit", "POST", { channelKey, text }, "edit");
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
