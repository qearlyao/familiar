// Option C: make a right-anchored user message hug its longest wrapped line.
//
// The user bubble renders as a `width: fit-content` block clamped to the column.
// fit-content derives from the *unwrapped* max-content and, when that overflows, just
// clamps to the available width — it never shrinks to the longest *wrapped* line. So a
// message that wraps to multiple lines leaves ragged whitespace against its right edge.
//
// We measure rendered text lines plus atomic content boxes and pin the container
// width to the rightmost content edge. The whole message is hugged as one unit (not
// per paragraph), so paragraphs and list items keep a shared left edge while the box
// hugs the single widest line or block. Because the width equals the natural widest
// content edge, wrap points are unchanged — only the empty right-edge gap disappears.

/**
 * Hugged width for a container: the rightmost line-box edge, relative to the
 * container's left, rounded up and capped to the available parent width. `left`
 * and each rect's `right` are viewport coordinates from the same layout pass.
 * Returns 0 when there are no lines.
 *
 * Measuring the right *edge* (not bare line width) is what lets an indented line
 * — e.g. a list item — set the width without overflowing the box.
 */
export function huggedWidth(
  rects: ArrayLike<{ right: number }>,
  left: number,
  maxWidth = Number.POSITIVE_INFINITY,
): number {
  let maxRight = -Infinity;
  for (let i = 0; i < rects.length; i += 1) {
    const { right } = rects[i];
    if (right > maxRight) maxRight = right;
  }
  if (maxRight === -Infinity) return 0;
  const measuredWidth = Math.max(0, maxRight - left);
  const clampedWidth = Number.isFinite(maxWidth)
    ? Math.min(measuredWidth, Math.max(0, maxWidth))
    : measuredWidth;
  return Math.ceil(clampedWidth);
}

function parentWidth(container: HTMLElement): number {
  const width = container.parentElement?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY;
  return width > 0 ? width : Number.POSITIVE_INFINITY;
}

function pushElementRightEdge(element: HTMLElement, rects: { right: number }[]): void {
  const { left, right, width } = element.getBoundingClientRect();
  const scrollWidth = element.scrollWidth;
  if (width > 0) rects.push({ right });
  if (scrollWidth > width) rects.push({ right: left + scrollWidth });
}

function messageContentRects(container: HTMLElement): ArrayLike<{ right: number }> {
  const rects: { right: number }[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width > 0) rects.push(rect);
    }
  }

  container
    .querySelectorAll<HTMLElement>("button, img, video, audio, canvas, svg, iframe, pre, .chat-markdown-table")
    .forEach((element) => pushElementRightEdge(element, rects));

  return rects;
}

/**
 * Pin `container` to the width of its widest rendered line. Idempotent: clears any
 * prior pin first so it re-measures at the current available width.
 */
export function hugMessage(container: HTMLElement): void {
  container.style.width = "";
  const rects = messageContentRects(container);
  if (rects.length === 0) return;
  const width = huggedWidth(rects, container.getBoundingClientRect().left, parentWidth(container));
  if (width > 0) container.style.width = `${width}px`;
}
