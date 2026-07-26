import type { PageSegment } from "./marginMessage.js";

/** Past this much overshoot from snapping outward, fall back to a sentence break. */
const OVERSHOOT_LIMIT = 300;
const SENTENCE_END = /[.!?。！？”"』」)\]]\s/g;

/** Pull the paragraph boundary toward the visible start when snapping overshot too far. */
export function trimStart(text: string, visibleStart: number, paragraphStart: number): number {
  if (visibleStart - paragraphStart <= OVERSHOOT_LIMIT) return paragraphStart;
  const window = text.slice(paragraphStart, visibleStart);
  SENTENCE_END.lastIndex = 0;
  let cut: number | undefined;
  for (let m = SENTENCE_END.exec(window); m; m = SENTENCE_END.exec(window)) cut = m.index + m[0].length;
  return cut === undefined ? visibleStart - OVERSHOOT_LIMIT : paragraphStart + cut;
}

export function trimEnd(text: string, visibleEnd: number, paragraphEnd: number): number {
  if (paragraphEnd - visibleEnd <= OVERSHOOT_LIMIT) return paragraphEnd;
  const window = text.slice(visibleEnd, paragraphEnd);
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(window); m; m = SENTENCE_END.exec(window)) {
    const at = visibleEnd + m.index + m[0].length;
    if (at - visibleEnd > OVERSHOOT_LIMIT) return at;
  }
  return paragraphEnd;
}

/**
 * Turn the visible paragraphs' offset spans into the page payload. Only the
 * outer edges can overshoot — interior paragraphs are fully on-page — so those
 * are the only two boundaries that get trimmed back toward what's on screen.
 */
export function pageSegments(
  text: string,
  spans: readonly { start: number; end: number }[],
  visible: { start: number; end: number },
): { segments: PageSegment[]; start: number; end: number } | undefined {
  if (spans.length === 0) return undefined;
  const firstVisible = spans[0]!;
  const lastVisible = spans[spans.length - 1]!;
  const start = trimStart(text, visible.start, firstVisible.start);
  const end = trimEnd(text, visible.end, lastVisible.end);

  const segments = spans
    .map((span, i) => {
      const from = i === 0 ? start : span.start;
      const to = i === spans.length - 1 ? end : span.end;
      return { start: from, end: to, text: text.slice(from, to).trim() };
    })
    .filter((segment) => segment.text.length > 0);
  if (segments.length === 0) return undefined;
  return { segments, start, end };
}
