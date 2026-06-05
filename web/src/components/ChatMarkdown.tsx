import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { MediaPreview } from "@/components/MediaPreview";
import { remarkImageParagraphs } from "@/lib/chatMarkdownLayout";
import { remarkLegacyChatMedia } from "@/lib/chatMarkdownMedia";
import { cn } from "@/lib/utils";

const remarkPlugins = [remarkGfm, remarkLegacyChatMedia, remarkImageParagraphs];

function markdownComponents(align: "start" | "end"): Components {
  return {
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
      return (
        <MediaPreview
          src={src}
          alt={alt ?? "image"}
          className={cn("my-1 block w-fit", align === "end" && "ml-auto")}
        />
      );
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
}

export function ChatMarkdown({
  text,
  streaming,
  align = "start",
}: {
  text: string;
  streaming: boolean;
  align?: "start" | "end";
}) {
  const components = useMemo(() => markdownComponents(align), [align]);

  return (
    <div
      className={cn(
        "warm-prose chat-markdown",
        align === "end" && "chat-markdown-end",
        streaming && "chat-markdown-streaming",
      )}
    >
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
