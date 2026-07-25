import { createElement } from "react";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { MarkdownRenderer } from "../MarkdownRenderer";

const remarkPlugins = [remarkGfm];
const components: Components = {
  h1: "h2",
  h2: "h2",
  h3: "h3",
  h4: "h3",
  h5: "h3",
  h6: "h3",
};
const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/gm;
const DIARY_BEAT_RE = /([^\n])\n(?=(?:[A-Z][A-Za-z ]{0,32}\s+)?\(?\d{1,2}:\d{2}\)?\s*[:.)-])/g;

export function MarkdownView({ content, title }: { content: string; title: string }) {
  const markdown = prepareDiaryMarkdown(content, title);
  if (!markdown) {
    return createElement(
      "p",
      { className: "font-serif text-sm italic text-muted-foreground" },
      "this day is quiet.",
    );
  }
  return createElement(MarkdownRenderer, {
    text: markdown,
    className: "warm-prose diary-prose",
    components,
    remarkPlugins,
  });
}

function prepareDiaryMarkdown(content: string, title: string): string {
  let sawHeading = false;
  const normalizedTitle = normalizeHeadingText(title);
  return content
    .replace(/\r\n?/g, "\n")
    .replace(HEADING_RE, (line, heading: string) => {
      if (sawHeading) return line;
      sawHeading = true;
      return normalizeHeadingText(heading) === normalizedTitle ? "" : line;
    })
    .replace(DIARY_BEAT_RE, "$1\n\n")
    .trim();
}

function normalizeHeadingText(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#>]/g, "")
    .trim()
    .toLowerCase();
}
