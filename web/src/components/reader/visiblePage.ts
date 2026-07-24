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

  for (const { node } of index.nodes) {
    if (!node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    const onPage = Array.from(range.getClientRects()).some(
      (rect) =>
        rect.width > 0 &&
        rect.left >= bounds.left - EDGE_SLACK &&
        rect.right <= bounds.right + EDGE_SLACK &&
        rect.bottom > bounds.top &&
        rect.top < bounds.bottom,
    );
    if (!onPage) continue;
    const block = blockAncestor(node, content);
    if (blocks[blocks.length - 1] !== block) blocks.push(block);
  }

  const spans = blocks.map((block) => spanOf(index, block)).filter((s): s is { start: number; end: number } => !!s);
  return pageSegments(index.text, spans);
}
