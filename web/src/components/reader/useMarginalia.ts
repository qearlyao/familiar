import { useCallback, useEffect, useRef, useState } from "react";
import {
  createMarginalia,
  deleteMarginalia,
  fetchMarginalia,
  updateMarginalia,
  type MarginaliaEntry,
} from "@/lib/api";
import { anchorFromOffsets, findQuote, offsetsToRange, type TextIndex } from "./anchors";

const MARK_HIGHLIGHT = "book-mark";
const NOTE_HIGHLIGHT = "book-note";

export interface MarginaliaHit {
  entry: MarginaliaEntry;
  /** The tapped line's rect (viewport coordinates), for anchoring the note card. */
  rect: DOMRect;
}

/** Vertical slack so a tap just off a line still lands on its passage. */
const HIT_PAD = 3;

/**
 * Loads a book's marginalia and paints the current chapter's entries via the
 * CSS Custom Highlight API (no DOM mutation, so pagination is undisturbed).
 * The painted highlight itself is the affordance: entryAt() resolves a tap
 * back to the passage under it.
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
  const rangesRef = useRef<Map<string, Range>>(new Map());

  useEffect(() => {
    let cancelled = false;
    fetchMarginalia(bookId)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  // Resolve this chapter's anchors to ranges and paint highlights.
  useEffect(() => {
    if (!textIndex || typeof CSS === "undefined" || !("highlights" in CSS)) return;
    const marks: Range[] = [];
    const notes: Range[] = [];
    const resolved = new Map<string, Range>();
    for (const entry of entries) {
      if (entry.chapter !== chapter) continue;
      const found = findQuote(textIndex, entry.quote, entry.prefix, entry.suffix);
      if (!found) continue;
      const range = offsetsToRange(textIndex, found.start, found.end);
      if (!range) continue;
      resolved.set(entry.id, range);
      (entry.note ? notes : marks).push(range);
    }
    rangesRef.current = resolved;
    CSS.highlights.set(MARK_HIGHLIGHT, new Highlight(...marks));
    CSS.highlights.set(NOTE_HIGHLIGHT, new Highlight(...notes));
    return () => {
      CSS.highlights.delete(MARK_HIGHLIGHT);
      CSS.highlights.delete(NOTE_HIGHLIGHT);
    };
  }, [chapter, entries, textIndex]);

  // Ranges live-track layout (they're DOM ranges), so hit-testing needs no
  // re-measure step: check the tapped point against each passage's line rects.
  const entryAt = useCallback((x: number, y: number): MarginaliaHit | undefined => {
    let hit: MarginaliaHit | undefined;
    for (const entry of entries) {
      const range = rangesRef.current.get(entry.id);
      if (!range) continue;
      for (const rect of range.getClientRects()) {
        if (rect.width === 0 || rect.height === 0) continue;
        if (x < rect.left || x > rect.right) continue;
        if (y < rect.top - HIT_PAD || y > rect.bottom + HIT_PAD) continue;
        // Overlapping passages: prefer the one with writing under it.
        if (!hit || (entry.note && !hit.entry.note)) hit = { entry, rect };
        break;
      }
    }
    return hit;
  }, [entries]);

  const add = useCallback(
    async (draft: { start: number; end: number; note?: string }) => {
      if (!textIndex) return undefined;
      const anchor = anchorFromOffsets(textIndex, draft.start, draft.end);
      try {
        const entry = await createMarginalia(bookId, { chapter, ...anchor, note: draft.note });
        setEntries((prev) => [...prev, entry]);
        setError(undefined);
        return entry;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return undefined;
      }
    },
    [bookId, chapter, textIndex],
  );

  const saveNote = useCallback(
    async (entryId: string, note: string) => {
      try {
        const entry = await updateMarginalia(bookId, entryId, note);
        setEntries((prev) => prev.map((e) => (e.id === entryId ? entry : e)));
        setError(undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
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
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [bookId],
  );

  return { entryAt, add, saveNote, remove, error };
}
