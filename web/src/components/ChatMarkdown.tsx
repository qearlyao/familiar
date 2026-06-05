import type { Image, Link, PhrasingContent, Text } from "mdast";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Parent } from "unist";
import { SKIP, visit } from "unist-util-visit";

import { MediaPreview } from "@/components/MediaPreview";
import { cn } from "@/lib/utils";

const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp)(?:\?[^\s]*)?$/i;
const LEGACY_MEDIA_RE =
  /meme:\s*([^\n]*?)\s*\((https?:\/\/[^\s)<>"']+)\)|(https?:\/\/[^\s)<>"']+)/gi;

const remarkPlugins = [remarkGfm, remarkLegacyChatMedia];

const components: Components = {
  a(props) {
    const { node, href, children, ...anchorProps } = props;
    void node;
    const external = href ? !href.startsWith("#") : false;
    return (
      <a
        {...anchorProps}
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
      >
        {children}
      </a>
    );
  },
  img(props) {
    const { node, src, alt } = props;
    void node;
    if (typeof src !== "string" || !src) return null;
    return <MediaPreview src={src} alt={alt ?? "image"} />;
  },
  table(props) {
    const { node, ...tableProps } = props;
    void node;
    return (
      <div className="chat-markdown-table">
        <table {...tableProps} />
      </div>
    );
  },
};

function textNode(value: string): Text {
  return { type: "text", value };
}

function imageNode(url: string, alt = ""): Image {
  return { type: "image", url, alt };
}

function isImageUrl(url: string): boolean {
  return IMAGE_EXT_RE.test(url);
}

function splitLegacyMedia(value: string): PhrasingContent[] | undefined {
  const nodes: PhrasingContent[] = [];
  let cursor = 0;

  for (const match of value.matchAll(LEGACY_MEDIA_RE)) {
    const index = match.index ?? 0;
    const memeUrl = match[2];
    const bareUrl = match[3];
    const url = memeUrl ?? bareUrl;
    if (!url || (!memeUrl && !isImageUrl(url))) continue;

    if (index > cursor) nodes.push(textNode(value.slice(cursor, index)));
    nodes.push(imageNode(url, memeUrl ? (match[1] ?? "").trim() : ""));
    cursor = index + match[0].length;
  }

  if (nodes.length === 0) return undefined;
  if (cursor < value.length) nodes.push(textNode(value.slice(cursor)));
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

function remarkLegacyChatMedia() {
  return (tree: Parameters<typeof visit>[0]) => {
    visit(tree, "link", (node: Link, index, parent) => {
      if (index === undefined || !parent) return SKIP;
      if (isPlainImageLink(node)) {
        replaceChild(parent, index, [imageNode(node.url)]);
      }
      return SKIP;
    });

    visit(tree, "text", (node: Text, index, parent) => {
      if (index === undefined || !parent) return SKIP;
      const replacement = splitLegacyMedia(node.value);
      if (!replacement) return;
      replaceChild(parent, index, replacement);
      return [SKIP, index + replacement.length];
    });
  };
}

export function ChatMarkdown({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  return (
    <div className={cn("warm-prose chat-markdown", streaming && "chat-markdown-streaming")}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
