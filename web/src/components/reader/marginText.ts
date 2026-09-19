import type { BookChapterInfo, MarginaliaEntry } from "@/lib/api";

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "today", "yesterday", "3 days ago", then the date */
export function noteAge(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days < 7) return relative.format(-Math.max(days, 0), "day");
  return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" }).toLowerCase();
}

export function chapterLabel(chapter: number, chapters: BookChapterInfo[]): string {
  const title = chapters.find((item) => item.index === chapter)?.title;
  return title || `chapter ${chapter + 1}`;
}

export const initial = (name: string) => name.slice(0, 1).toUpperCase();

export type EntryKind = "thread" | "note" | "highlight";

/** Her voice wins: a passage she's answered reads as hers, whatever else is on it. */
export function entryKind(entry: MarginaliaEntry): EntryKind {
  if (entry.thread.length > 0) return "thread";
  return entry.note ? "note" : "highlight";
}

export const companionReplies = (entry: MarginaliaEntry) => entry.thread.filter((message) => message.author === "companion");

/** "12 notes" everywhere means your notes plus her replies. */
export function noteTally(entries: MarginaliaEntry[]) {
  const yours = entries.filter((entry) => entry.note).length;
  const hers = entries.reduce((sum, entry) => sum + companionReplies(entry).length, 0);
  return { yours, hers, total: yours + hers };
}
