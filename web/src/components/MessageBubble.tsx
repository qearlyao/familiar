import { memo } from "react";
import type { Attachment, Message } from "../types";
import { cn } from "@/lib/utils";
import { renderInlineText } from "@/lib/renderInlineText";
import { AudioPlayer } from "./AudioPlayer";
import { TurnView } from "./TurnView";

function AttachmentItem({ attachment }: { attachment: Attachment }) {
  if (!attachment.url) return null;
  const isImage = attachment.kind === "image" || attachment.mimeType?.startsWith("image/");
  if (isImage) {
    return (
      <a href={attachment.url} className="inline-block">
        <img src={attachment.url} alt={attachment.name} className="max-h-72 max-w-[24rem] rounded-md" />
      </a>
    );
  }
  if (attachment.mimeType?.startsWith("audio/")) {
    return <AudioPlayer src={attachment.url} name={attachment.name} />;
  }
  return (
    <a
      href={attachment.url}
      className="text-sm italic text-muted-foreground underline-offset-4 hover:underline"
    >
      {attachment.name}
    </a>
  );
}

function AttachmentList({ attachments, align }: { attachments: Attachment[]; align: "left" | "right" }) {
  if (attachments.length === 0) return null;
  return (
    <div className={cn("mt-2 flex flex-col gap-2", align === "right" && "items-end")}>
      {attachments.map((attachment) => (
        <AttachmentItem key={attachment.id} attachment={attachment} />
      ))}
    </div>
  );
}

function UserTurn({ message }: { message: Message }) {
  const text = message.steps
    .filter((s) => s.kind === "text")
    .map((s) => (s.kind === "text" ? s.text : ""))
    .join("");
  return (
    <div className="flex w-full flex-col items-end gap-1">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">
        {message.who}
      </span>
      <div className="flex min-w-0 max-w-[85%] flex-col items-end">
        {text && renderInlineText(text, { align: "end" })}
        <AttachmentList attachments={message.attachments ?? []} align="right" />
      </div>
    </div>
  );
}

function SystemTurn({ message }: { message: Message }) {
  const text = message.steps.find((s) => s.kind === "text");
  if (!text || text.kind !== "text") return null;
  return (
    <div className="flex justify-center">
      <p className="text-xs italic text-muted-foreground">{text.text}</p>
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({ message }: { message: Message }) {
  if (message.role === "system") return <SystemTurn message={message} />;
  if (message.role === "user") return <UserTurn message={message} />;
  return (
    <div className="flex w-full flex-col">
      <TurnView message={message} />
      <AttachmentList attachments={message.attachments ?? []} align="left" />
    </div>
  );
});
