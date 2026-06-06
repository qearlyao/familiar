export type DiaryInlineSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string };

export type DiaryBlock =
  | { kind: "heading"; level: 2 | 3; inline: DiaryInlineSegment[] }
  | { kind: "paragraph"; inline: DiaryInlineSegment[] }
  | { kind: "blockquote"; inline: DiaryInlineSegment[] }
  | { kind: "list"; ordered: boolean; items: DiaryInlineSegment[][] };

const INLINE_PATTERN = /(`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;

export function diaryMarkdownBlocks(content: string, title: string): DiaryBlock[] {
  const builder = new DiaryBlockBuilder(title);

  for (const rawLine of content.replace(/\r\n/g, "\n").split("\n")) {
    builder.addLine(rawLine.trim());
  }

  return builder.finish();
}

class DiaryBlockBuilder {
  private blocks: DiaryBlock[] = [];
  private paragraph: string[] = [];
  private listItems: string[] = [];
  private listKind: "ul" | "ol" | undefined;
  private sawHeading = false;
  private readonly title: string;

  constructor(title: string) {
    this.title = title;
  }

  addLine(line: string): void {
    if (!line) {
      this.flush();
      return;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      this.addHeading(heading[1]?.length ?? 1, heading[2] ?? "");
      return;
    }

    const unordered = /^[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const kind = unordered ? "ul" : "ol";
      this.addListItem(kind, (unordered?.[1] ?? ordered?.[1] ?? "").trim());
      return;
    }

    const quote = /^>\s+(.+)$/.exec(line);
    if (quote) {
      this.flush();
      this.blocks.push({ kind: "blockquote", inline: splitDiaryInline(quote[1] ?? "") });
      return;
    }

    if (startsDiaryBeat(line) && this.paragraph.length > 0) {
      this.flushParagraph();
    }
    this.paragraph.push(line);
  }

  finish(): DiaryBlock[] {
    this.flush();
    return this.blocks;
  }

  private addHeading(sourceLevel: number, text: string): void {
    this.flush();
    if (!this.sawHeading && normalizeHeadingText(text) === normalizeHeadingText(this.title)) {
      this.sawHeading = true;
      return;
    }
    this.sawHeading = true;
    this.blocks.push({
      kind: "heading",
      level: sourceLevel <= 2 ? 2 : 3,
      inline: splitDiaryInline(text),
    });
  }

  private addListItem(kind: "ul" | "ol", text: string): void {
    this.flushParagraph();
    if (this.listKind && this.listKind !== kind) this.flushList();
    this.listKind = kind;
    this.listItems.push(text);
  }

  private flush(): void {
    this.flushParagraph();
    this.flushList();
  }

  private flushParagraph(): void {
    const text = this.paragraph.join(" ").trim();
    if (text) this.blocks.push({ kind: "paragraph", inline: splitDiaryInline(text) });
    this.paragraph = [];
  }

  private flushList(): void {
    if (!this.listKind || this.listItems.length === 0) return;
    this.blocks.push({
      kind: "list",
      ordered: this.listKind === "ol",
      items: this.listItems.map((item) => splitDiaryInline(item)),
    });
    this.listKind = undefined;
    this.listItems = [];
  }
}

export function splitDiaryInline(text: string): DiaryInlineSegment[] {
  const segments: DiaryInlineSegment[] = [];
  let cursor = 0;

  INLINE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ kind: "text", text: text.slice(cursor, index) });
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (match[2]) segments.push({ kind: "code", text: value });
    else if (match[3]) segments.push({ kind: "strong", text: value });
    else segments.push({ kind: "em", text: value });
    cursor = index + match[0].length;
  }

  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

function startsDiaryBeat(line: string): boolean {
  return /^(?:[A-Z][A-Za-z ]{0,32}\s+)?\(?\d{1,2}:\d{2}\)?\s*[:.)-]/.test(line);
}

function normalizeHeadingText(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#>]/g, "")
    .trim()
    .toLowerCase();
}
