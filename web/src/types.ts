export type Role = "user" | "assistant" | "system";

export interface Message {
  id: string;
  role: Role;
  who: string;
  text: string;
  attachments?: Attachment[];
  thinking?: string;
  thinkingMs?: number;
  ts: number;
}

export interface Attachment {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  url?: string;
}
