export type Role = "user" | "assistant" | "system";

export interface Message {
  id: string;
  role: Role;
  who: string;
  text: string;
  thinking?: string;
  thinkingMs?: number;
  ts: number;
}
