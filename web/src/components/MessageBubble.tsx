import { memo, useState } from "react";
import { type LucideIcon, RotateCcw, Trash2 } from "lucide-react";
import type { Attachment, Message } from "../types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { renderInlineText } from "@/lib/renderInlineText";
import { AudioPlayer } from "./AudioPlayer";
import { MediaPreview } from "./MediaPreview";
import { TurnView } from "./TurnView";

function AttachmentItem({ attachment }: { attachment: Attachment }) {
  if (!attachment.url) return null;
  const isImage = attachment.kind === "image" || attachment.mimeType?.startsWith("image/");
  if (isImage) {
    return <MediaPreview src={attachment.url} alt={attachment.name} />;
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

function ActionButton({
  icon: Icon,
  label,
  onClick,
  hoverClass,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  hoverClass: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "h-7 px-2 text-muted-foreground opacity-70 transition-opacity group-hover:opacity-100",
        hoverClass,
      )}
    >
      <Icon className="size-3.5" />
    </Button>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  onRetry,
  onDelete,
}: {
  message: Message;
  onRetry?: () => void;
  onDelete?: () => void;
}) {
  const [actionsRevealed, setActionsRevealed] = useState(false);
  if (message.role === "system") return <SystemTurn message={message} />;
  if (message.role === "user") return <UserTurn message={message} />;
  return (
    <div
      className="group flex w-full flex-col"
      onPointerDown={(event) => {
        if (event.pointerType !== "mouse") setActionsRevealed(true);
      }}
    >
      <TurnView message={message} />
      <AttachmentList attachments={message.attachments ?? []} align="left" />
      {(onRetry || onDelete) && (
        <div
          className={cn(
            "pointer-events-none mt-2 flex opacity-0 transition-opacity duration-150 ease-out group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
            actionsRevealed && "pointer-events-auto opacity-100",
          )}
        >
          {onRetry && (
            <ActionButton
              icon={RotateCcw}
              label="retry latest reply"
              onClick={onRetry}
              hoverClass="hover:text-foreground"
            />
          )}
          {onDelete && (
            <ActionButton
              icon={Trash2}
              label="delete latest reply"
              onClick={onDelete}
              hoverClass="hover:text-destructive"
            />
          )}
        </div>
      )}
    </div>
  );
});
