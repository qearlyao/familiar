import type { ReactNode } from "react";

import { ChatMarkdown } from "@/components/ChatMarkdown";

interface RenderOptions {
  trailingCursor?: boolean;
  align?: "start" | "end";
}

const cursor = <span className="ml-0.5 inline-block animate-pulse">▎</span>;

export function renderInlineText(text: string, opts: RenderOptions = {}): ReactNode {
  const { trailingCursor, align = "start" } = opts;
  if (!text.trim()) {
    return trailingCursor ? <div className="warm-prose chat-markdown">{cursor}</div> : null;
  }

  const content = <ChatMarkdown text={text} streaming={trailingCursor === true} />;
  if (align !== "end") {
    return content;
  }

  return <div className="flex min-w-0 flex-col items-end">{content}</div>;
}
