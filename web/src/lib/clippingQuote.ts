import type { Message } from "../types.js";
import { withoutSilentMarker } from "./silentMarker.js";

/** how much of one message, and of the whole clipping, goes back into the talk as a quote */
export const QUOTE_MESSAGE_CHARS = 400;
export const QUOTE_CHARS = 2000;

/** what a turn said out loud, without its thoughts */
export function said(message: Message): string {
  return withoutSilentMarker(message.steps.map((step) => (step.kind === "text" ? step.text : "")).join(""));
}

/** what a search of the shelf looks through: your line and everything that was said */
export function clippingText(clipping: { title?: string; note?: string; messages: Message[] }): string {
  return [clipping.title ?? "", clipping.note ?? "", ...clipping.messages.map(said)].join("\n");
}

const CITATION_RE = /^—\s+(kept from .+)$/;

/** The line a clipping quote ends on ("— kept from 3 november 2026"), so the chat can fold the quote
    behind it. Takes the blockquote's plain text, as the margin citation does. */
export function clippingQuoteCitation(text: string): string | undefined {
  const line = text.trimEnd().split("\n").pop()?.trim() ?? "";
  return CITATION_RE.exec(line)?.[1];
}

/** A clipping as quoted text for the draft: what was said, trimmed. Thoughts and media stay on the shelf. */
export function clippingQuote(messages: Message[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const message of messages) {
    if (message.role === "system") continue;
    const text = (said(message) || (message.attachments ?? []).map((attachment) => `[${attachment.name}]`).join(" ")).replace(/\s*\n\s*/g, " ");
    if (!text) continue;
    const line = `${message.who}: ${text.length > QUOTE_MESSAGE_CHARS ? `${text.slice(0, QUOTE_MESSAGE_CHARS).trimEnd()}…` : text}`;
    if (used + line.length > QUOTE_CHARS) {
      lines.push("…");
      break;
    }
    used += line.length;
    lines.push(line);
  }
  const first = messages[0];
  if (first) lines.push(`— kept from ${new Date(first.ts).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" }).toLowerCase()}`);
  // a bare ">" between turns keeps each on its own line once the bubble renders it as markdown
  return lines.map((line) => `> ${line}`).join("\n>\n");
}
