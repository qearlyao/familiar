const CONTEXT_CHARS = 32;

export interface TextIndex {
  text: string;
  nodes: { node: Text; start: number }[];
}

/** Flatten a chapter's text nodes into one string with per-node offsets. */
export function buildTextIndex(root: HTMLElement): TextIndex {
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, start: text.length });
    text += node.textContent ?? "";
  }
  return { text, nodes };
}

function locate(index: TextIndex, offset: number): { node: Text; offset: number } | undefined {
  const entry = index.nodes.findLast(({ start }) => start <= offset);
  if (!entry) return undefined;
  const within = Math.min(offset - entry.start, entry.node.textContent?.length ?? 0);
  return { node: entry.node, offset: within };
}

export function offsetsToRange(index: TextIndex, start: number, end: number): Range | undefined {
  const from = locate(index, start);
  const to = locate(index, end);
  if (!from || !to) return undefined;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

export function rangeToOffsets(index: TextIndex, range: Range): { start: number; end: number } | undefined {
  const toOffset = (container: Node, offset: number): number | undefined => {
    if (container.nodeType === Node.TEXT_NODE) {
      const entry = index.nodes.find((n) => n.node === container);
      return entry ? entry.start + offset : undefined;
    }
    // Element container: resolve to the first text position at/after the child boundary.
    const children = container.childNodes;
    for (let i = offset; i < children.length; i += 1) {
      const walker = document.createTreeWalker(children[i], NodeFilter.SHOW_TEXT);
      const first = walker.nextNode();
      if (first) {
        const entry = index.nodes.find((n) => n.node === first);
        if (entry) return entry.start;
      }
    }
    return index.text.length;
  };
  const start = toOffset(range.startContainer, range.startOffset);
  const end = toOffset(range.endContainer, range.endOffset);
  if (start === undefined || end === undefined || end <= start) return undefined;
  return { start, end };
}

export function anchorFromOffsets(
  index: TextIndex,
  start: number,
  end: number,
): { quote: string; prefix: string; suffix: string } {
  return {
    quote: index.text.slice(start, end),
    prefix: index.text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: index.text.slice(end, end + CONTEXT_CHARS),
  };
}

/** Find a stored quote in the chapter, using prefix/suffix to break ties. */
export function findQuote(
  index: TextIndex,
  quote: string,
  prefix: string,
  suffix: string,
): { start: number; end: number } | undefined {
  if (!quote) return undefined;
  let best: { start: number; score: number } | undefined;
  for (let at = index.text.indexOf(quote); at >= 0; at = index.text.indexOf(quote, at + 1)) {
    const before = index.text.slice(Math.max(0, at - prefix.length), at);
    const after = index.text.slice(at + quote.length, at + quote.length + suffix.length);
    let score = 0;
    if (prefix && before === prefix) score += 1;
    if (suffix && after === suffix) score += 1;
    if (!best || score > best.score) best = { start: at, score };
    if (best.score === 2) break;
  }
  if (!best) return undefined;
  return { start: best.start, end: best.start + quote.length };
}
