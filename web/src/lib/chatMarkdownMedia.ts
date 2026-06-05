import type { Image, Link, Paragraph, PhrasingContent, Root, Text } from "mdast";
import type { Parent } from "unist";
import { SKIP, visit } from "unist-util-visit";

import {
  IMAGE_URL_RE,
  legacyMediaTokens,
  splitLegacyMemeLinkPrefix,
} from "./legacyMemeToken.js";

function textNode(value: string): Text {
  return { type: "text", value };
}

function imageNode(url: string, alt = ""): Image {
  return { type: "image", url, alt };
}

function pushText(nodes: PhrasingContent[], value: string): void {
  const text = value.replace(/[ \t]+$/, "").replace(/\n{2,}$/, "\n");
  if (text.trim()) nodes.push(textNode(text));
}

export function splitLegacyChatMedia(value: string): PhrasingContent[] | undefined {
  const nodes: PhrasingContent[] = [];
  let cursor = 0;

  for (const token of legacyMediaTokens(value)) {
    if (token.index > cursor) pushText(nodes, value.slice(cursor, token.index));
    nodes.push(imageNode(token.url, token.type === "meme" ? token.name : ""));
    cursor = token.index + token.whole.length;
  }

  if (nodes.length === 0) return undefined;
  if (cursor < value.length) pushText(nodes, value.slice(cursor).replace(/^\n+/, ""));
  return nodes;
}

function isPlainImageLink(node: Link): boolean {
  const child = node.children[0];
  return (
    node.title == null &&
    node.children.length === 1 &&
    child?.type === "text" &&
    child.value === node.url &&
    IMAGE_URL_RE.test(node.url)
  );
}

function replaceChild(parent: Parent, index: number, replacement: PhrasingContent[]): void {
  parent.children.splice(index, 1, ...replacement);
}

function rewriteLegacyLinkedMedia(parent: Paragraph): void {
  const { children } = parent;
  for (let index = 1; index < children.length - 1; index += 1) {
    const previous = children[index - 1];
    const node = children[index];
    const next = children[index + 1];

    if (
      previous?.type !== "text" ||
      node?.type !== "link" ||
      next?.type !== "text" ||
      !next.value.startsWith(")") ||
      !isPlainImageLink(node)
    ) {
      continue;
    }

    const prefix = splitLegacyMemeLinkPrefix(previous.value);
    if (!prefix) continue;

    const replacement: PhrasingContent[] = [];
    pushText(replacement, prefix.before);
    replacement.push(imageNode(node.url, prefix.name));
    pushText(replacement, next.value.slice(1).replace(/^\n+/, ""));
    children.splice(index - 1, 3, ...replacement);
    index += Math.max(0, replacement.length - 2);
  }
}

export function remarkLegacyChatMedia() {
  return (tree: Root) => {
    visit(tree, "paragraph", (node: Paragraph) => {
      rewriteLegacyLinkedMedia(node);
    });

    visit(tree, "link", (node: Link, index, parent) => {
      if (index === undefined || !parent) return SKIP;
      if (isPlainImageLink(node)) {
        replaceChild(parent, index, [imageNode(node.url)]);
      }
      return SKIP;
    });

    visit(tree, "text", (node: Text, index, parent) => {
      if (index === undefined || !parent || parent.type === "link") return SKIP;
      const replacement = splitLegacyChatMedia(node.value);
      if (!replacement) return;
      replaceChild(parent, index, replacement);
      return [SKIP, index + replacement.length];
    });
  };
}
