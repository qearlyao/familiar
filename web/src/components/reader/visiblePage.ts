import type { TextIndex } from "./anchors.js";
import type { PageSegment } from "./marginMessage.js";
import { pageSegments } from "./pageBounds.js";

/** Columns land within a pixel or two of the viewport edge; don't count a hairline sliver as visible. */
const EDGE_SLACK = 4;

function blockAncestor(node: Text, root: HTMLElement): HTMLElement {
  let el = node.parentElement;
  while (el && el !== root) {
    const style = getComputedStyle(el);
    // Floats blockify (a drop-cap span computes as block); keep climbing so the
    // chapter's first letter lands in its paragraph, not as its own block.
    if (style.float === "none" && style.display !== "inline" && style.display !== "inline-block") return el;
    el = el.parentElement;
  }
  return root;
}

function spanOf(index: TextIndex, block: HTMLElement): { start: number; end: number } | undefined {
  const inside = index.nodes.filter(({ node }) => block.contains(node));
  if (inside.length === 0) return undefined;
  const first = inside[0]!;
  const last = inside[inside.length - 1]!;
  return { start: first.start, end: last.start + (last.node.textContent?.length ?? 0) };
}

function pointOffset(index: TextIndex, x: number, y: number): number | undefined {
  const position = document.caretPositionFromPoint?.(x, y);
  const range = document.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? range?.startContainer;
  const offset = position?.offset ?? range?.startOffset;
  if (node?.nodeType !== Node.TEXT_NODE || offset === undefined) return undefined;
  const entry = index.nodes.find(({ node: textNode }) => textNode === node);
  return entry ? entry.start + offset : undefined;
}

function visibleOffsets(index: TextIndex, entry: TextIndex["nodes"][number], rects: DOMRect[]): { start: number; end: number } {
  const entryEnd = entry.start + (entry.node.textContent?.length ?? 0);
  const offsets: number[] = [];
  for (const rect of [rects[0]!, rects[rects.length - 1]!]) {
    const inset = Math.min(1, rect.width / 2);
    for (const x of [rect.left + inset, rect.right - inset]) {
      const offset = pointOffset(index, x, rect.top + rect.height / 2);
      if (offset !== undefined) offsets.push(offset);
    }
  }
  if (offsets.length === 0) throw new Error("Unable to resolve visible page text bounds");
  const start = Math.max(entry.start, Math.min(entryEnd, Math.min(...offsets)));
  const end = Math.max(start, Math.min(entryEnd, Math.max(...offsets)));
  return { start, end: end === start && start < entryEnd ? start + 1 : end };
}

/**
 * What's actually on screen, snapped out to whole paragraphs. Columns flow
 * horizontally, so "visible" is a horizontal band: a text node is on this page
 * when its rects fall inside the viewport's box. Paragraph boundaries beat the
 * exact pixel slice — a page break lands mid-sentence, and a fragment starting
 * at "—but she had already" reads as noise.
 */
export function visiblePage(
  index: TextIndex,
  viewport: HTMLElement,
  content: HTMLElement,
): { segments: PageSegment[]; start: number; end: number } | undefined {
  const bounds = viewport.getBoundingClientRect();
  const blocks: HTMLElement[] = [];
  const range = document.createRange();
  let firstVisible: { entry: TextIndex["nodes"][number]; rects: DOMRect[] } | undefined;
  let lastVisible: typeof firstVisible;

  for (const entry of index.nodes) {
    if (!entry.node.textContent?.trim()) continue;
    range.selectNodeContents(entry.node);
    const rects = Array.from(range.getClientRects()).filter(
      (rect) =>
        rect.width > 0 &&
        rect.left >= bounds.left - EDGE_SLACK &&
        rect.right <= bounds.right + EDGE_SLACK &&
        rect.bottom > bounds.top &&
        rect.top < bounds.bottom,
    );
    if (rects.length === 0) continue;
    firstVisible ??= { entry, rects };
    lastVisible = { entry, rects };
    const block = blockAncestor(entry.node, content);
    if (blocks[blocks.length - 1] !== block) blocks.push(block);
  }

  if (!firstVisible || !lastVisible) return undefined;
  const spans = blocks.map((block) => spanOf(index, block)).filter((s): s is { start: number; end: number } => !!s);
  const start = visibleOffsets(index, firstVisible.entry, firstVisible.rects).start;
  const end = visibleOffsets(index, lastVisible.entry, lastVisible.rects).end;
  return pageSegments(index.text, spans, { start, end });
}
