import type { ReactNode } from "react";

import { collapseInlineSegments, parseInlineSegments } from "@/lib/inlineSegments";

export function renderInlineText(text: string): ReactNode {
  const items = collapseInlineSegments(parseInlineSegments(text));
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
