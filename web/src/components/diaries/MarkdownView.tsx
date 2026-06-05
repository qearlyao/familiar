import { useMemo, type ReactNode } from "react";

export function MarkdownView({ content, title }: { content: string; title: string }) {
  const blocks = useMemo(() => markdownBlocks(content, title), [content, title]);
  if (blocks.length === 0) {
    return <p className="font-serif text-sm italic text-muted-foreground">this day is quiet.</p>;
  }
  return <div className="diary-prose">{blocks}</div>;
}

function markdownBlocks(content: string, title: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const paragraph: string[] = [];
  let listItems: string[] = [];
  let listKind: "ul" | "ol" | undefined;
  let sawHeading = false;

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) nodes.push(<p key={nodes.length}>{splitInline(text)}</p>);
    paragraph.length = 0;
  };
  const flushList = () => {
    if (!listKind || listItems.length === 0) return;
    const Tag = listKind;
    nodes.push(
      <Tag key={nodes.length}>
        {listItems.map((item, index) => (
          <li key={index}>{splitInline(item)}</li>
        ))}
      </Tag>,
    );
    listItems = [];
    listKind = undefined;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (const rawLine of content.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? "";
      if (!sawHeading && normalizeHeadingText(text) === normalizeHeadingText(title)) {
        sawHeading = true;
        continue;
      }
      sawHeading = true;
      const Tag = level <= 2 ? "h2" : "h3";
      nodes.push(<Tag key={nodes.length}>{splitInline(text)}</Tag>);
      continue;
    }
    const unordered = /^[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const nextKind = unordered ? "ul" : "ol";
      if (listKind && listKind !== nextKind) flushList();
      listKind = nextKind;
      listItems.push((unordered?.[1] ?? ordered?.[1] ?? "").trim());
      continue;
    }
    const quote = /^>\s+(.+)$/.exec(line);
    if (quote) {
      flush();
      nodes.push(<blockquote key={nodes.length}>{splitInline(quote[1] ?? "")}</blockquote>);
      continue;
    }
    if (startsDiaryBeat(line) && paragraph.length > 0) {
      flushParagraph();
    }
    paragraph.push(line);
  }
  flush();
  return nodes;
}

function splitInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(text.slice(cursor, index));
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (match[2]) parts.push(<code key={parts.length}>{value}</code>);
    else if (match[3]) parts.push(<strong key={parts.length}>{value}</strong>);
    else parts.push(<em key={parts.length}>{value}</em>);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
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
