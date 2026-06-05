import { useLayoutEffect, useMemo, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { MediaPreview } from "@/components/MediaPreview";
import { remarkImageParagraphs } from "@/lib/chatMarkdownLayout";
import { remarkLegacyChatMedia } from "@/lib/chatMarkdownMedia";
import { hugParagraphs } from "@/lib/hugLines";
import { cn } from "@/lib/utils";

const remarkPlugins = [remarkGfm, remarkLegacyChatMedia, remarkImageParagraphs];

/**
 * Right-anchored user messages render as `fit-content` paragraphs, which clamp to the
 * column width and leave ragged whitespace against the right edge when text wraps. Pin
 * each paragraph to its widest line so the box hugs the text. Only the `end` alignment
 * shrink-wraps, so the `start` (assistant) path skips this entirely. User messages are
 * static — no streaming — so we re-measure on font load and viewport resize only.
 */
function useHugLines(ref: React.RefObject<HTMLDivElement | null>, enabled: boolean, text: string) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!enabled || !node) return;
    const measure = () => hugParagraphs(node);
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
