// Option C: make a right-anchored user message hug its longest wrapped line.
//
// The user bubble's <p> is `width: fit-content` clamped to the column. fit-content
// derives from the *unwrapped* max-content and, when that overflows, just clamps to
// the available width — it never shrinks to the longest *wrapped* line. So a message
// that wraps to multiple lines leaves ragged whitespace against the box's right edge.
//
// We fix that by measuring each rendered line box and pinning the paragraph width to
// the widest one. Because the chosen width equals the natural widest line, the wrap
// points are unchanged — only the empty right-edge gap disappears.

/** Widest line-box width (ceil) among a paragraph's client rects; 0 when empty. */
export function widestLineWidth(rects: ArrayLike<{ width: number }>): number {
  let max = 0;
  for (let i = 0; i < rects.length; i += 1) {
    const { width } = rects[i];
    if (width > max) max = width;
  }
  return Math.ceil(max);
}

/**
 * Pin each text paragraph directly under `root` to the width of its widest line.
 * Idempotent: clears any prior pin first so it re-measures at the current available
 * width. Media-only paragraphs (no text) keep their CSS-driven `fit-content` width.
 */
export function hugParagraphs(root: HTMLElement): void {
  const paragraphs = root.querySelectorAll<HTMLElement>(":scope > p");
  for (const paragraph of paragraphs) {
    paragraph.style.width = "";
    if (!paragraph.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const width = widestLineWidth(range.getClientRects());
    if (width > 0) paragraph.style.width = `${width}px`;
  }
}
