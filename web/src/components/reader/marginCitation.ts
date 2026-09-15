const CITATION_RE = /^—\s+(.+ · p\. \d+)$/;

/**
 * Recognize the citation line a margin prompt leaves at the end of its
 * blockquote ("— *Title*, chapter · p. 148"), so the chat can fold the passage
 * behind it. Takes the blockquote's plain text (markdown already parsed away).
 */
export function marginQuoteCitation(text: string): string | undefined {
  const line = text.trimEnd().split("\n").pop()?.trim() ?? "";
  return CITATION_RE.exec(line)?.[1];
}
