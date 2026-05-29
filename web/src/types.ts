export type Role = "user" | "assistant" | "system";

export interface Message {
  id: string;
  role: Role;
  who: string;
  steps: Step[];
  attachments?: Attachment[];
  usage?: Usage;
  silent?: boolean;
  ts: number;
}

export type Step = ThinkingStep | ToolStep | TextStep | ErrorStep;

export interface ThinkingStep {
  kind: "thinking";
  id: string;
  text: string;
  startedAt: number;
  endedAt?: number;
  complete?: boolean;
}

export interface ToolStep {
  kind: "tool";
  id: string;
  tool: ToolEvent;
}

export interface TextStep {
  kind: "text";
  id: string;
  text: string;
  complete?: boolean;
}

export interface ErrorStep {
  kind: "error";
  id: string;
  text: string;
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
