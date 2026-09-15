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
  const upsert = (entry: MarginaliaEntry) =>
    setEntries((prev) => (prev.some((e) => e.id === entry.id) ? prev.map((e) => (e.id === entry.id ? entry : e)) : [...prev, entry]));

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
    async (range: MarginRange) => {
      const anchor = anchorFor(range);
      if (!anchor) return undefined;
      try {
        const entry = await createMarginalia(bookId, anchor);
        upsert(entry);
        setError(undefined);
        return entry;
      } catch (err) {
        fail(err);
        return undefined;
      }
    },
    [anchorFor, bookId],
  );

  const discuss = useCallback(
    async (range: MarginRange) => {
      const anchor = anchorFor(range);
      if (!anchor) return undefined;
      try {
        const { entry } = await discussInMargin(bookId, { anchor });
        upsert(entry);
        setError(undefined);
        return entry;
      } catch (err) {
        fail(err);
        return undefined;
      }
    },
    [anchorFor, bookId],
  );

  const reply = useCallback(
    async (entryId: string, text: string) => {
      try {
        const { entry } = await discussInMargin(bookId, { entryId, text });
        upsert(entry);
        setError(undefined);
        return entry;
      } catch (err) {
        fail(err);
        return undefined;
      }
    },
    [bookId],
  );

  const saveNote = useCallback(
    async (entryId: string, note: string) => {
      try {
        upsert(await updateMarginalia(bookId, entryId, note));
        setError(undefined);
      } catch (err) {
        fail(err);
      }
    },
    [bookId],
  );

  const remove = useCallback(
    async (entryId: string) => {
      try {
        await deleteMarginalia(bookId, entryId);
        setEntries((prev) => prev.filter((e) => e.id !== entryId));
        setError(undefined);
      } catch (err) {
        fail(err);
      }
    },
    [bookId],
  );

  return { entries, ranges, entryAt, add, discuss, reply, saveNote, remove, error };
}
