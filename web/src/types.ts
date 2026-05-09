export type Role = "user" | "assistant" | "system";

export interface Message {
  id: string;
  role: Role;
  who: string;
  text: string;
  attachments?: Attachment[];
  thinking?: string;
  thinkingMs?: number;
  tools?: ToolEvent[];
  usage?: Usage;
  ts: number;
}

export interface Attachment {
  id: string;
  name: string;
  kind?: "image" | "file" | "audio" | "video";
  mimeType?: string;
  size?: number;
  url?: string;
}

export interface ToolEvent {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "error";
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  error?: string;
  startedAt?: number;
  updatedAt?: number;
  completedAt?: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}
