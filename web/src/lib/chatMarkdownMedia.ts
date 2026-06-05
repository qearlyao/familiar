import type { Image, Link, PhrasingContent, Root, Text } from "mdast";
import type { Parent } from "unist";
import { SKIP, visit } from "unist-util-visit";

const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp)(?:\?[^\s]*)?$/i;
const LEGACY_MEDIA_RE =
  /meme:\s*([^\n]*?)\s*\((https?:\/\/[^\s)<>"']+)\)|(https?:\/\/[^\s)<>"']+)/gi;

function textNode(value: string): Text {
  return { type: "text", value };
}

function imageNode(url: string, alt = ""): Image {
  return { type: "image", url, alt };
}

function isImageUrl(url: string): boolean {
  return IMAGE_EXT_RE.test(url);
}

function pushText(nodes: PhrasingContent[], value: string): void {
  const text = value.replace(/[ \t]+$/, "").replace(/\n{2,}$/, "\n");
  if (text.trim()) nodes.push(textNode(text));
}

export function splitLegacyChatMedia(value: string): PhrasingContent[] | undefined {
  const nodes: PhrasingContent[] = [];
  let cursor = 0;

  for (const match of value.matchAll(LEGACY_MEDIA_RE)) {
    const index = match.index ?? 0;
    const memeUrl = match[2];
    const bareUrl = match[3];
    const url = memeUrl ?? bareUrl;
    if (!url || (!memeUrl && !isImageUrl(url))) continue;

    if (index > cursor) pushText(nodes, value.slice(cursor, index));
    nodes.push(imageNode(url, memeUrl ? (match[1] ?? "").trim() : ""));
    cursor = index + match[0].length;
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
    isImageUrl(node.url)
  );
}

function replaceChild(parent: Parent, index: number, replacement: PhrasingContent[]): void {
  parent.children.splice(index, 1, ...replacement);
}

export function remarkLegacyChatMedia() {
  return (tree: Root) => {
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
