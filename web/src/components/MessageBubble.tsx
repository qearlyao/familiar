import type { Message } from "../types";
import { cn } from "@/lib/utils";
import { renderInlineText } from "@/lib/renderInlineText";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolBlock } from "./ToolBlock";

export function MessageBubble({ message }: { message: Message }) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <p className="text-xs italic text-muted-foreground">{message.text}</p>
      </div>
    );
  }

  const isUser = message.role === "user";
  const showThinking = !isUser && (message.thinking || message.thinkingMs != null);
  const attachments = message.attachments ?? [];

  return (
    <div className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}>
      <span className="text-xs uppercase tracking-wider text-muted-foreground">
        {message.who}
      </span>
      <div className={cn("flex flex-col", isUser ? "max-w-[85%]" : "max-w-full")}>
        {showThinking && (
          <ThinkingBlock
            text={message.thinking ?? ""}
            durationMs={message.thinkingMs}
          />
        )}
        {!isUser && <ToolBlock tools={message.tools ?? []} />}
        {message.text && renderInlineText(message.text)}
        {attachments.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {attachments.map((attachment) =>
              (attachment.kind === "image" || attachment.mimeType?.startsWith("image/")) && attachment.url ? (
                <a key={attachment.id} href={attachment.url} className="inline-block">
                  <img
                    src={attachment.url}
                    alt={attachment.name}
                    className="max-h-72 max-w-[24rem] rounded-md"
                  />
                </a>
              ) : attachment.mimeType?.startsWith("audio/") && attachment.url ? (
                <audio
                  key={attachment.id}
                  controls
                  preload="metadata"
                  src={attachment.url}
                  className="h-9 max-w-full"
                >
                  <a href={attachment.url}>{attachment.name}</a>
                </audio>
              ) : attachment.url ? (
                <a
                  key={attachment.id}
                  href={attachment.url}
                  className="text-sm italic text-muted-foreground underline-offset-4 hover:underline"
                >
                  {attachment.name}
                </a>
              ) : null,
            )}
          </div>
        )}
      </div>
    </div>
  );
}
