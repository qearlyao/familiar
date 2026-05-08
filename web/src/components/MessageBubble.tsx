import type { Message } from "../types";
import { cn } from "@/lib/utils";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolInlineBlock } from "./ToolBlock";

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
  const parts =
    message.parts?.length
      ? message.parts
      : message.text
        ? [{ type: "text" as const, id: "text_legacy", text: message.text }]
        : [];

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
        {parts.map((part) =>
          part.type === "tool" ? (
            <ToolInlineBlock key={part.id} tool={part.tool} />
          ) : (
            <div key={part.id} className="whitespace-pre-wrap break-words leading-relaxed text-foreground">
              {part.text}
            </div>
          ),
        )}
        {attachments.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {attachments.map((attachment) =>
              attachment.mimeType?.startsWith("audio/") && attachment.url ? (
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
