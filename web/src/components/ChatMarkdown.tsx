import { type ReactNode, useMemo, useState } from "react";
import { BookOpenText } from "lucide-react";
import { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { MediaPreview } from "@/components/MediaPreview";
import { pageQuoteCitation } from "@/components/reader/marginMessage";
import { CHAT_MARKDOWN_LINK_CARD_CLASS, remarkImageParagraphs, remarkLinkCards } from "@/lib/chatMarkdownLayout";
import { cn } from "@/lib/utils";

const remarkPlugins = [remarkGfm, remarkImageParagraphs, remarkLinkCards];

/** Plain text of a hast subtree; soft line breaks survive inside text values. */
function hastText(node: unknown): string {
  if (node == null || typeof node !== "object") return "";
  const el = node as { type?: string; value?: string; children?: unknown[] };
  if (el.type === "text") return el.value ?? "";
  return (el.children ?? []).map(hastText).join("");
}

/** The unfurled form (4e): a patch, the host under a sage dot, and the words the agent chose. */
function LinkCard({ href, children }: { href: string; children: ReactNode }) {
  const [iconBroken, setIconBroken] = useState(false);
  const url = useMemo(() => {
    try {
      return new URL(href);
    } catch {
      return undefined;
    }
  }, [href]);
  if (!url) return <a href={href}>{children}</a>;
  const host = url.hostname.replace(/^www\./, "");
  // a bare URL has no words to show: the path reads better as a title than the whole href
  const title = children === href ? decodeURI(url.pathname + url.search).replace(/^\/$/, host) : children;

  return (
    <a className={CHAT_MARKDOWN_LINK_CARD_CLASS} href={href} target="_blank" rel="noopener noreferrer">
      <span className="chat-link-mark">
        {!iconBroken && (
          <img src={`https://${host}/favicon.ico`} alt="" loading="lazy" onError={() => setIconBroken(true)} />
        )}
      </span>
      <span className="chat-link-body">
        <span className="chat-link-host">
          <span className="chat-link-dot" />
          {host}
        </span>
        <span className="chat-link-title">{title}</span>
      </span>
    </a>
  );
}

function markdownComponents(align: "start" | "end"): Components {
  return {
    a(props) {
      const { node, href, children, ...anchorProps } = props;
      void node;
      if (href && anchorProps.className === CHAT_MARKDOWN_LINK_CARD_CLASS) return <LinkCard href={href}>{children}</LinkCard>;
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
          className={cn("my-1 block w-fit max-w-full", align === "end" && "ml-auto")}
        />
      );
    },
    // A page sent from a book's margins is context, not conversation: fold it
    // behind its citation line so the exchange stays readable.
    blockquote(props) {
      const { node, children, ...blockquoteProps } = props;
      const citation = pageQuoteCitation(hastText(node));
      if (!citation) return <blockquote {...blockquoteProps}>{children}</blockquote>;
      return (
        <details>
          <summary className="flex w-fit max-w-full cursor-pointer list-none items-center gap-1.5 font-serif text-xs italic text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <BookOpenText className="size-3.5 shrink-0" />
            <span className="truncate">{citation}</span>
          </summary>
          <blockquote {...blockquoteProps}>{children}</blockquote>
        </details>
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
      <MarkdownRenderer text={text} remarkPlugins={remarkPlugins} components={components} />
    </div>
  );
}
