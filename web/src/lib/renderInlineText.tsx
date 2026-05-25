import type { ReactNode } from "react";

import { collapseInlineSegments, parseInlineSegments } from "@/lib/inlineSegments";

interface RenderOptions {
  trailingCursor?: boolean;
}

const cursor = <span className="ml-0.5 inline-block animate-pulse">▎</span>;

export function renderInlineText(text: string, opts: RenderOptions = {}): ReactNode {
  const { trailingCursor } = opts;
  const items = collapseInlineSegments(parseInlineSegments(text));
  if (items.length === 0) {
    return trailingCursor ? (
      <div className="whitespace-pre-wrap break-words leading-relaxed text-foreground">
        {cursor}
      </div>
    ) : null;
  }
  if (items.length === 1 && items[0].type === "text") {
    return (
      <div className="whitespace-pre-wrap break-words leading-relaxed text-foreground">
        {items[0].value}
        {trailingCursor && cursor}
      </div>
    );
  }
  const lastIndex = items.length - 1;
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, i) => {
        const isLast = i === lastIndex;
        if (item.type === "text") {
          return (
            <div
              key={i}
              className="whitespace-pre-wrap break-words leading-relaxed text-foreground"
            >
              {item.value}
              {trailingCursor && isLast && cursor}
            </div>
          );
        }
        return (
          <div key={i} className="flex flex-col">
            <a href={item.url} target="_blank" rel="noopener noreferrer" className="inline-block">
              <img
                src={item.url}
                alt={item.alt || "meme"}
                loading="lazy"
                className="max-h-72 max-w-[24rem] rounded-md"
              />
            </a>
            {trailingCursor && isLast && (
              <div className="leading-relaxed text-foreground">{cursor}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
