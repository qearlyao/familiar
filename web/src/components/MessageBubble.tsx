import type { Message } from "../types";
import { cn } from "@/lib/utils";
import { renderInlineText } from "@/lib/renderInlineText";
import { AudioPlayer } from "./AudioPlayer";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolBlock } from "./ToolBlock";

function AttachmentList({ attachments }: { attachments: NonNullable<Message["attachments"]> }) {
  if (attachments.length === 0) return null;
  return (
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
          <AudioPlayer
            key={attachment.id}
            src={attachment.url}
            name={attachment.name}
          />
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
  );
}

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

  if (message.silent) {
    const tools = message.tools ?? [];
    return (
      <div className="flex flex-col items-start gap-3">
        {showThinking && (
          <ThinkingBlock
            text={message.thinking ?? ""}
            durationMs={message.thinkingMs}
          />
        )}
        {tools.length > 0 && <ToolBlock tools={tools} />}
        <AttachmentList attachments={attachments} />
        <div className="flex w-full justify-center">
          <p className="text-xs italic text-muted-foreground">
            they kept quiet
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}>
      <span className="text-xs uppercase tracking-wider text-muted-foreground">
        {message.who}
      </span>
      <div className={cn("flex flex-col", isUser ? "max-w-[85%]" : "w-full")}>
        {showThinking && (
          <ThinkingBlock
            text={message.thinking ?? ""}
            durationMs={message.thinkingMs}
          />
        )}
        {!isUser && <ToolBlock tools={message.tools ?? []} />}
        {message.text && renderInlineText(message.text)}
        <AttachmentList attachments={attachments} />
      </div>
    </div>
  );
}
