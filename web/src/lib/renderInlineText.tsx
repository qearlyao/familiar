import type { ReactNode } from "react";

import { collapseInlineSegments, parseInlineSegments } from "@/lib/inlineSegments";
import { cn } from "@/lib/utils";

interface RenderOptions {
  trailingCursor?: boolean;
  align?: "start" | "end";
}

const cursor = <span className="ml-0.5 inline-block animate-pulse">▎</span>;
// wrap-anywhere (overflow-wrap: anywhere) — unlike break-words, it shrinks the
// flex item's min-content size, so long URLs wrap instead of overflowing.
const textBlock = "whitespace-pre-wrap wrap-anywhere leading-relaxed text-foreground";

export function renderInlineText(text: string, opts: RenderOptions = {}): ReactNode {
  const { trailingCursor, align = "start" } = opts;
  const alignEnd = align === "end";
  const items = collapseInlineSegments(parseInlineSegments(text));
  if (items.length === 0) {
    return trailingCursor ? <div className={textBlock}>{cursor}</div> : null;
  }
  if (items.length === 1 && items[0].type === "text") {
    return (
      <div className={textBlock}>
        {items[0].value}
        {trailingCursor && cursor}
      </div>
    );
  }
  const lastIndex = items.length - 1;
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", alignEnd && "items-end")}>
      {items.map((item, i) => {
        const isLast = i === lastIndex;
        if (item.type === "text") {
          return (
            <div key={i} className={textBlock}>
              {item.value}
              {trailingCursor && isLast && cursor}
            </div>
          );
        }
        return (
          <div key={i} className={cn("flex flex-col", alignEnd && "items-end")}>
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
