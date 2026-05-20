import type { ReactNode } from "react";

type Segment =
  | { type: "text"; value: string }
  | { type: "image"; url: string; alt: string };

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp)(?:\?[^\s]*)?$/i;
const PATTERN_RE =
  /meme:\s+([^\n()]+?)\s+\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s)<>"']+/gi;

function parse(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  PATTERN_RE.lastIndex = 0;
  while ((match = PATTERN_RE.exec(text)) !== null) {
    const [whole, memeName, memeUrl] = match;
    const url = memeUrl ?? whole;
    const isMeme = Boolean(memeName);
    const isImage = isMeme || IMAGE_EXT_RE.test(url);
    if (!isImage) continue;
    if (match.index > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, match.index) });
    }
    segments.push({ type: "image", url, alt: memeName?.trim() ?? "" });
    cursor = match.index + whole.length;
  }
  if (cursor < text.length) {
    segments.push({ type: "text", value: text.slice(cursor) });
  }
  return segments;
}

function collapse(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  let buffer = "";
  for (const seg of segments) {
    if (seg.type === "text") {
      buffer += seg.value;
      continue;
    }
    const trimmed = buffer.replace(/[ \t]+$/, "").replace(/\n{2,}$/, "\n");
    if (trimmed.trim()) out.push({ type: "text", value: trimmed });
    buffer = "";
    out.push(seg);
  }
  const tail = buffer.replace(/^\n+/, "");
  if (tail.trim()) out.push({ type: "text", value: tail });
  return out;
}

export function renderInlineText(text: string): ReactNode {
  const items = collapse(parse(text));
  if (items.length === 0) return null;
  if (items.length === 1 && items[0].type === "text") {
    return (
      <div className="whitespace-pre-wrap break-words leading-relaxed text-foreground">
        {items[0].value}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, i) =>
        item.type === "text" ? (
          <div
            key={i}
            className="whitespace-pre-wrap break-words leading-relaxed text-foreground"
          >
            {item.value}
          </div>
        ) : (
          <a
            key={i}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block"
          >
            <img
              src={item.url}
              alt={item.alt || "meme"}
              loading="lazy"
              className="max-h-72 max-w-[24rem] rounded-md"
            />
          </a>
        ),
      )}
    </div>
  );
}
