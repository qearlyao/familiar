import { createElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { PluggableList } from "unified";

export type MarkdownRendererProps = {
  text: string;
  className?: string;
  components?: Components;
  remarkPlugins?: PluggableList;
};

export function MarkdownRenderer({
  text,
  className,
  components,
  remarkPlugins,
}: MarkdownRendererProps) {
  const markdown = createElement(ReactMarkdown, { remarkPlugins, components }, text);
  if (className) return createElement("div", { className }, markdown);
  return markdown;
}
