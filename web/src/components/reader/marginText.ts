import type { BookChapterInfo, MarginaliaEntry } from "@/lib/api";

export function noteAge(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
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
