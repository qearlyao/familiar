import { useLayoutEffect, useMemo, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { MediaPreview } from "@/components/MediaPreview";
import { remarkImageParagraphs } from "@/lib/chatMarkdownLayout";
import { remarkLegacyChatMedia } from "@/lib/chatMarkdownMedia";
import { hugMessage } from "@/lib/hugLines";
import { cn } from "@/lib/utils";

const remarkPlugins = [remarkGfm, remarkLegacyChatMedia, remarkImageParagraphs];

/**
 * Right-anchored user messages render as a `fit-content` block, which clamps to the
 * column width and leaves ragged whitespace against the right edge when text wraps. Pin
 * the whole message to its widest rendered line so the box hugs the text as one unit —
 * paragraphs and list items share a left edge instead of floating independently. Only
 * the `end` alignment shrink-wraps, so the `start` (assistant) path skips this. User
 * messages are static — no streaming — so we re-measure on font load and resize only.
 */
function useHugLines(ref: React.RefObject<HTMLDivElement | null>, enabled: boolean, text: string) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!enabled || !node) return;
    const measure = () => hugMessage(node);
    measure();
    window.addEventListener("resize", measure);
    document.fonts?.ready.then(measure);
    return () => window.removeEventListener("resize", measure);
  }, [ref, enabled, text]);
}

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
  const ref = useRef<HTMLDivElement>(null);
  useHugLines(ref, align === "end", text);

  return (
    <div
      ref={ref}
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
