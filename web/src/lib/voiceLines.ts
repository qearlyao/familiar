import { mmss } from "./clock.js";

export interface VoiceLine {
  id: string;
  who: "you" | "them";
  text: string;
  final: boolean;
  /** ms since the call picked up */
  at: number;
}

/** A line is keyed by id; "you" lines without one fill the open partial.
    Once your words are final they move to the end and take that moment as their time — that's the
    order the call's session hears them in, so a typed line or reply in between never ends up after them. */
export function placeLine(
  lines: readonly VoiceLine[],
  who: VoiceLine["who"],
  text: string,
  final: boolean,
  at: number,
  id?: string,
): VoiceLine[] {
  const index = id ? lines.findIndex((line) => line.id === id) : lines.findLastIndex((line) => line.who === who && !line.final);
  if (index < 0) return [...lines, { id: id ?? `${who}-${at}-${lines.length}`, who, text, final, at }];
  const line = { ...lines[index], text, final };
  if (who === "you" && final && !id) {
    return [...lines.slice(0, index), ...lines.slice(index + 1), { ...line, at }];
  }
  const next = lines.slice();
  next[index] = line;
  return next;
}

/** 04:12 — the call clock keeps its leading zero */
export const clock = (ms: number) => mmss(ms / 1000).padStart(5, "0");
