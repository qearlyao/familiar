export interface PageSegment {
  /** Absolute offsets into the chapter's flattened text, aligned with `text`. */
  start: number;
  end: number;
  text: string;
}

export interface PendingQuote {
  quote: string;
  chapterTitle?: string;
  chapterIndex: number;
  start: number;
  end: number;
}

export interface PendingPage {
  segments: PageSegment[];
  start: number;
  end: number;
  chapterTitle?: string;
  chapterIndex: number;
}

const MARK_OPEN = "⟦";
const MARK_CLOSE = "⟧";
const MARK_KEY = `${MARK_OPEN}…${MARK_CLOSE} marks the passage i've selected.`;

function blockquote(text: string): string {
  return `> ${text.replaceAll("\n", "\n> ")}`;
}

function chapterLabel(chapterTitle: string | undefined, chapterIndex: number): string {
  return chapterTitle || `ch ${chapterIndex + 1}`;
}

/**
 * Paragraph breaks plus the offsets he'd need to find this again, so a future
 * book tool can act on the citation instead of re-reading a pasted page.
 */
function pageBlock(bookTitle: string, page: PendingPage, mark?: { start: number; end: number }): string {
  const body = page.segments
    .map((segment) => {
      if (!mark) return segment.text;
      let text = segment.text;
      // Close before open: inserting the open marker first would shift the close offset.
      if (mark.end > segment.start && mark.end <= segment.end) {
        const at = mark.end - segment.start;
        text = `${text.slice(0, at)}${MARK_CLOSE}${text.slice(at)}`;
      }
      if (mark.start >= segment.start && mark.start < segment.end) {
        const at = mark.start - segment.start;
        text = `${text.slice(0, at)}${MARK_OPEN}${text.slice(at)}`;
      }
      return text;
    })
    .join("\n\n");
  const cite = `— *${bookTitle}*, ${chapterLabel(page.chapterTitle, page.chapterIndex)} · ${page.start}–${page.end}`;
  return `${blockquote(body)}\n${cite}`;
}

function quoteBlock(bookTitle: string, quote: PendingQuote): string {
  const cite = quote.chapterTitle ? `— *${bookTitle}*, ${quote.chapterTitle}` : `— *${bookTitle}*`;
  return `${blockquote(quote.quote)}\n${cite}`;
}

function encloses(page: PendingPage, quote: PendingQuote): boolean {
  return quote.chapterIndex === page.chapterIndex && quote.start >= page.start && quote.end <= page.end;
}

const CITATION_RE = /^—\s+(.+ · \d+–\d+)$/;

/**
 * Recognize the citation line pageBlock leaves at the end of its blockquote,
 * so renderers can fold the page behind it. Takes the blockquote's plain text
 * (markdown markers already parsed away); returns the citation without the dash.
 */
export function pageQuoteCitation(text: string): string | undefined {
  const line = text.trimEnd().split("\n").pop()?.trim() ?? "";
  return CITATION_RE.exec(line)?.[1];
}

/**
 * One payload, never two copies of the same words: when the page contains the
 * quoted passage, the passage is marked in place rather than repeated.
 */
export function formatMarginMessage(
  bookTitle: string,
  text: string,
  quote?: PendingQuote,
  page?: PendingPage,
): string {
  if (page && quote) {
    if (encloses(page, quote)) {
      return `${MARK_KEY}\n\n${pageBlock(bookTitle, page, quote)}\n\n${text}`;
    }
    return `${quoteBlock(bookTitle, quote)}\n\nand the page i'm on now:\n\n${pageBlock(bookTitle, page)}\n\n${text}`;
  }
  if (page) return `${pageBlock(bookTitle, page)}\n\n${text}`;
  if (quote) return `${quoteBlock(bookTitle, quote)}\n\n${text}`;
  return text;
}
