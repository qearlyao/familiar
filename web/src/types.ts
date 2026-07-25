import type {
  WebAttachment,
  WebMessage,
  WebStep,
  WebToolEvent,
  WebUsage,
} from "../../src/web/types.js";

export type Role = WebMessage["role"];
export type Step = WebStep;
export type ThinkingStep = Extract<Step, { kind: "thinking" }>;
export type ToolStep = Extract<Step, { kind: "tool" }>;
export type TextStep = Extract<Step, { kind: "text" }>;
export type ErrorStep = Extract<Step, { kind: "error" }>;
export type Attachment = WebAttachment;
export type ToolEvent = WebToolEvent;
export type Usage = WebUsage;

export type Message = Pick<
  WebMessage,
  "id" | "role" | "who" | "attachments" | "usage" | "silent" | "bookId" | "ts"
> & {
  steps: Step[];
};
