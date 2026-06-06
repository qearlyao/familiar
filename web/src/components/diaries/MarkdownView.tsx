import { createElement, useMemo, type ReactNode } from "react";

import { diaryMarkdownBlocks, type DiaryBlock, type DiaryInlineSegment } from "../../lib/diaryMarkdown";

export function MarkdownView({ content, title }: { content: string; title: string }) {
  const blocks = useMemo(() => diaryMarkdownBlocks(content, title), [content, title]);
  if (blocks.length === 0) {
    return createElement(
      "p",
      { className: "font-serif text-sm italic text-muted-foreground" },
      "this day is quiet.",
    );
  }
  return createElement("div", { className: "warm-prose diary-prose" }, blocks.map(renderBlock));
}

function renderBlock(block: DiaryBlock, index: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = block.level === 2 ? "h2" : "h3";
      return createElement(Tag, { key: index }, renderInline(block.inline));
    }
    case "paragraph":
      return createElement("p", { key: index }, renderInline(block.inline));
    case "blockquote":
      return createElement("blockquote", { key: index }, renderInline(block.inline));
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return createElement(
        Tag,
        { key: index },
        block.items.map((item, itemIndex) =>
          createElement("li", { key: itemIndex }, renderInline(item)),
        ),
      );
    }
  }
}

function renderInline(segments: DiaryInlineSegment[]): ReactNode[] {
  return segments.map((segment, index) => {
    switch (segment.kind) {
      case "text":
        return segment.text;
      case "code":
        return createElement("code", { key: index }, segment.text);
      case "strong":
        return createElement("strong", { key: index }, segment.text);
      case "em":
        return createElement("em", { key: index }, segment.text);
    }
  });
}
