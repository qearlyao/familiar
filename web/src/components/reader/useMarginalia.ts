import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createMarginalia,
  deleteMarginalia,
  discussInMargin,
  fetchMarginalia,
  updateMarginalia,
  type MarginScale,
  type MarginaliaEntry,
} from "@/lib/api";
import { anchorFromOffsets, findQuote, offsetsToRange, type TextIndex } from "./anchors";

const MARK_HIGHLIGHT = "book-mark";
const NOTE_HIGHLIGHT = "book-note";
const THREAD_HIGHLIGHT = "book-thread";
/** How often to look for her reply while a thread is waiting. */
const REPLY_POLL_MS = 2500;

export interface MarginRange {
  start: number;
  end: number;
  scale: MarginScale;
}

export interface MarginaliaHit {
  entry: MarginaliaEntry;
  /** The tapped line's rect (viewport coordinates), for anchoring the note card. */
  rect: DOMRect;
}

/** Vertical slack so a tap just off a line still lands on its passage. */
const HIT_PAD = 3;

export const isWaiting = (entry: MarginaliaEntry) => entry.thread.at(-1)?.reply === "waiting";

/**
 * Loads a book's margin — highlights, notes, and threads with her — and paints
 * the current chapter's passages via the CSS Custom Highlight API (no DOM
 * mutation, so pagination is undisturbed). entryAt() resolves a tap back to
 * the passage under it; ranges hands each passage's live range to layout.
 */
export function useMarginalia({
  bookId,
  chapter,
  textIndex,
}: {
  bookId: string;
  chapter: number;
  textIndex: TextIndex | undefined;
}) {
  const [entries, setEntries] = useState<MarginaliaEntry[]>([]);
  const [error, setError] = useState<string>();

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
  /** run a server change; an entry that comes back lands in the list, a failure lands in `error` */
  const mutate = useCallback(async (op: () => Promise<MarginaliaEntry | void>) => {
    try {
      const entry = await op();
      if (entry) setEntries((prev) => (prev.some((e) => e.id === entry.id) ? prev.map((e) => (e.id === entry.id ? entry : e)) : [...prev, entry]));
      setError(undefined);
      return entry || undefined;
    } catch (err) {
      fail(err);
      return undefined;
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      setEntries(await fetchMarginalia(bookId));
      setError(undefined);
    } catch (err) {
      fail(err);
    }
  }, [bookId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  // ponytail: poll while she's replying; switch to the event stream if the delay ever feels slow.
  const waiting = entries.some(isWaiting);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void refresh(), REPLY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, waiting]);

  // Resolved on demand from the live text, so layout code can ask during render.
  const ranges = useMemo(() => {
    const resolved = new Map<string, Range>();
    if (!textIndex) return resolved;
    for (const entry of entries) {
      if (entry.chapter !== chapter) continue;
      const found = findQuote(textIndex, entry.quote, entry.prefix, entry.suffix);
      const range = found ? offsetsToRange(textIndex, found.start, found.end) : undefined;
      if (range) resolved.set(entry.id, range);
    }
    return resolved;
  }, [chapter, entries, textIndex]);

  useEffect(() => {
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
    const paint = { marks: [] as Range[], notes: [] as Range[], threads: [] as Range[] };
    for (const entry of entries) {
      const range = ranges.get(entry.id);
      if (!range) continue;
      // Page-sized threads are context, not a passage: underlining a page reads as noise.
      if (entry.thread.length > 0) {
        if (entry.scale !== "page") paint.threads.push(range);
      } else (entry.note ? paint.notes : paint.marks).push(range);
    }
    CSS.highlights.set(MARK_HIGHLIGHT, new Highlight(...paint.marks));
    CSS.highlights.set(NOTE_HIGHLIGHT, new Highlight(...paint.notes));
    CSS.highlights.set(THREAD_HIGHLIGHT, new Highlight(...paint.threads));
    return () => {
      CSS.highlights.delete(MARK_HIGHLIGHT);
      CSS.highlights.delete(NOTE_HIGHLIGHT);
      CSS.highlights.delete(THREAD_HIGHLIGHT);
    };
  }, [entries, ranges]);

  // Ranges live-track layout (they're DOM ranges), so hit-testing needs no
  // re-measure step: check the tapped point against each passage's line rects.
  const entryAt = useCallback((x: number, y: number): MarginaliaHit | undefined => {
    let hit: MarginaliaHit | undefined;
    for (const entry of entries) {
      if (entry.scale === "page") continue;
      const range = ranges.get(entry.id);
      if (!range) continue;
      for (const rect of range.getClientRects()) {
        if (rect.width === 0 || rect.height === 0) continue;
        if (x < rect.left || x > rect.right) continue;
        if (y < rect.top - HIT_PAD || y > rect.bottom + HIT_PAD) continue;
        // Overlapping passages: prefer the one with writing under it.
        if (!hit || ((entry.note || entry.thread.length) && !(hit.entry.note || hit.entry.thread.length))) hit = { entry, rect };
        break;
      }
    }
    return hit;
  }, [entries, ranges]);

  const anchorFor = useCallback(
    (range: MarginRange) =>
      textIndex ? { chapter, offset: range.start, scale: range.scale, ...anchorFromOffsets(textIndex, range.start, range.end) } : undefined,
    [chapter, textIndex],
  );

  const add = useCallback(
    (range: MarginRange) => {
      const anchor = anchorFor(range);
      return anchor ? mutate(() => createMarginalia(bookId, anchor)) : Promise.resolve(undefined);
    },
    [anchorFor, bookId, mutate],
  );

  const discuss = useCallback(
    (range: MarginRange) => {
      const anchor = anchorFor(range);
      return anchor ? mutate(async () => (await discussInMargin(bookId, { anchor })).entry) : Promise.resolve(undefined);
    },
    [anchorFor, bookId, mutate],
  );

  const reply = useCallback(
    (entryId: string, text: string) => mutate(async () => (await discussInMargin(bookId, { entryId, text })).entry),
    [bookId, mutate],
  );

  const saveNote = useCallback(
    (entryId: string, note: string) => mutate(() => updateMarginalia(bookId, entryId, note)),
    [bookId, mutate],
  );

  const remove = useCallback(
    (entryId: string) =>
      mutate(async () => {
        await deleteMarginalia(bookId, entryId);
        setEntries((prev) => prev.filter((e) => e.id !== entryId));
      }),
    [bookId, mutate],
  );

  return { entries, ranges, entryAt, add, discuss, reply, saveNote, remove, error };
}
