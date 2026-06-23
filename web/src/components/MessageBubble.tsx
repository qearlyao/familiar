import { memo, type ReactNode, useState } from "react";
import { Check, type LucideIcon, RotateCcw, SquarePen, Trash2, X } from "lucide-react";
import type { Attachment, Message } from "../types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { renderInlineText } from "@/lib/renderInlineText";
import { AudioPlayer } from "./AudioPlayer";
import { MediaPreview } from "./MediaPreview";
import { TurnView } from "./TurnView";

type PreviewableImageAttachment = Attachment & { url: string };

type AttachmentRenderItem =
  | { type: "attachment"; attachment: Attachment }
  | { type: "image-album"; attachments: PreviewableImageAttachment[] };

function AttachmentContext({ derived }: { derived: NonNullable<Attachment["derivedText"]> }) {
  return (
    <div className="mt-2 border-l border-border/80 pl-3 text-left font-serif text-xs italic leading-relaxed text-muted-foreground">
      {derived.label ? <span>{derived.label}: </span> : null}
      {derived.text}
    </div>
  );
}

function attachmentPreview(attachment: Attachment): { align?: "right"; content: ReactNode } | undefined {
  if (isPreviewableImageAttachment(attachment)) {
    return { content: <MediaPreview src={attachment.url} alt={attachment.name} /> };
  }
  if (!attachment.url) return undefined;
  return {
    align: "right",
    content: (
      <a
        href={attachment.url}
        className="text-sm italic text-muted-foreground underline-offset-4 hover:underline"
      >
        {attachment.name}
      </a>
    ),
  };
}

function isPreviewableImageAttachment(attachment: Attachment): attachment is PreviewableImageAttachment {
  return Boolean(attachment.url) && (attachment.kind === "image" || attachment.mimeType?.startsWith("image/") === true);
}

function attachmentRenderItems(attachments: Attachment[]): AttachmentRenderItem[] {
  const imageAttachments = attachments.filter(isPreviewableImageAttachment);
  if (imageAttachments.length < 2) {
    return attachments.map((attachment) => ({ type: "attachment", attachment }));
  }

  const firstAlbumImageId = imageAttachments[0].id;
  return attachments.flatMap((attachment): AttachmentRenderItem[] => {
    if (!isPreviewableImageAttachment(attachment)) {
      return [{ type: "attachment", attachment }];
    }
    if (attachment.id !== firstAlbumImageId) {
      return [];
    }
    return [{ type: "image-album", attachments: imageAttachments }];
  });
}

function imageAlbumTileClass(count: number, index: number): string {
  if (count === 2) return "aspect-[3/4]";
  if (count % 2 === 1 && index === count - 1) return "col-span-2 aspect-[2/1]";
  return "aspect-square";
}

function ImageAttachmentAlbum({ attachments }: { attachments: PreviewableImageAttachment[] }) {
  return (
    <div className="w-80 max-w-full rounded-md border border-border/80 bg-card/70 p-1 shadow-xs sm:w-96">
      <div className="grid grid-cols-2 gap-1">
        {attachments.map((attachment, index) => (
          <div
            key={attachment.id}
            className={cn(
              "min-w-0 overflow-hidden rounded-sm bg-muted",
              imageAlbumTileClass(attachments.length, index),
            )}
          >
            <MediaPreview
              src={attachment.url}
              alt={attachment.name}
              className="block h-full w-full overflow-hidden rounded-sm sm:max-w-none"
              imageClassName="h-full w-full max-h-none object-cover"
            />
          </div>
        ))}
      </div>
      {attachments.map((attachment) =>
        attachment.derivedText ? (
          <AttachmentContext key={`${attachment.id}-context`} derived={attachment.derivedText} />
        ) : null,
      )}
    </div>
  );
}

function AttachmentItem({ attachment, align }: { attachment: Attachment; align: "left" | "right" }) {
  if (attachment.url && attachment.mimeType?.startsWith("video/")) {
    return (
      <div className={cn("max-w-full", align === "right" && "ml-auto")}>
        <div className="w-80 max-w-full sm:w-96">
          <video
            src={attachment.url}
            controls
            preload="metadata"
            className="aspect-video w-full rounded-md bg-muted object-contain"
          />
          {attachment.derivedText ? <AttachmentContext derived={attachment.derivedText} /> : null}
        </div>
      </div>
    );
  }
  if (attachment.url && attachment.mimeType?.startsWith("audio/")) {
    return (
      <div className={cn("flex w-full max-w-sm flex-col", align === "right" && "ml-auto")}>
        <AudioPlayer src={attachment.url} name={attachment.name} />
        {attachment.derivedText ? <AttachmentContext derived={attachment.derivedText} /> : null}
      </div>
    );
  }
  const preview = attachmentPreview(attachment);
  if (!preview) return null;
  return (
    <div className={cn("max-w-full", (align === "right" || preview.align === "right") && "ml-auto text-right")}>
      {preview.content}
      {attachment.derivedText ? <AttachmentContext derived={attachment.derivedText} /> : null}
    </div>
  );
}

function AttachmentList({ attachments, align }: { attachments: Attachment[]; align: "left" | "right" }) {
  if (attachments.length === 0) return null;
  const renderItems = attachmentRenderItems(attachments);
  return (
    <div className={cn("mt-2 flex flex-col gap-2", align === "right" && "items-end")}>
      {renderItems.map((item) => {
        if (item.type === "image-album") {
          return <ImageAttachmentAlbum key="image-attachment-album" attachments={item.attachments} />;
        }
        return <AttachmentItem key={item.attachment.id} attachment={item.attachment} align={align} />;
      })}
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

function messageText(message: Message): string {
  return message.steps
    .filter((step) => step.kind === "text")
    .map((step) => (step.kind === "text" ? step.text : ""))
    .join("");
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
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  hoverClass: string;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "h-7 px-2 text-muted-foreground opacity-70 transition-opacity group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-35",
        hoverClass,
      )}
    >
      <Icon className="size-3.5" />
    </Button>
  );
}

function RetryDots() {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs italic text-muted-foreground/75">
      <span>retrying</span>
      <span className="inline-flex items-center gap-1 motion-reduce:gap-0.5" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="size-1 rounded-full bg-current opacity-35 animate-[retry-dot_900ms_cubic-bezier(0.25,1,0.5,1)_infinite] motion-reduce:animate-none"
            style={{ animationDelay: `${index * 140}ms` }}
          />
        ))}
      </span>
    </span>
  );
}

function AssistantEditForm({
	initialText,
	onSave,
	onCancel,
	saving,
}: {
	initialText: string;
	onSave?: (text: string) => Promise<void>;
	onCancel: () => void;
	saving: boolean;
}) {
  const [editText, setEditText] = useState(initialText);
  const save = async (): Promise<void> => {
    if (!onSave) return;
    await onSave(editText);
    onCancel();
  };
  return (
    <div className="flex w-full flex-col gap-2">
      <textarea
        value={editText}
        onChange={(event) => setEditText(event.target.value)}
        rows={Math.max(3, Math.min(12, editText.split("\n").length))}
        className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 font-serif text-sm leading-relaxed text-foreground shadow-sm focus:border-ring focus:ring-3 focus:ring-ring/30 focus:outline-none"
        autoFocus
      />
      <div className="flex gap-1">
        <ActionButton
          icon={Check}
          label={saving ? "saving edit" : "save edit"}
          onClick={() => {
            void save().catch(() => undefined);
          }}
          hoverClass="hover:text-foreground"
          disabled={saving || !editText.trim()}
        />
        <ActionButton
          icon={X}
          label="cancel edit"
          onClick={onCancel}
          hoverClass="hover:text-foreground"
          disabled={saving}
        />
      </div>
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  onRetry,
  onDelete,
  onEdit,
  pendingLatestAssistantAction,
}: {
  message: Message;
  onRetry?: () => void;
  onDelete?: () => void;
  onEdit?: (text: string) => Promise<void>;
  pendingLatestAssistantAction?: "retry" | "delete" | "edit";
}) {
  const [actionsRevealed, setActionsRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const retrying = pendingLatestAssistantAction === "retry";
  const savingEdit = pendingLatestAssistantAction === "edit";
  const latestAssistantActionPending = pendingLatestAssistantAction != null;
  const currentText = messageText(message);
  const canEdit = !!onEdit && !!currentText.trim();
  if (message.role === "system") return <SystemTurn message={message} />;
  if (message.role === "user") return <UserTurn message={message} />;
  if (editing) {
    return (
      <AssistantEditForm
        initialText={currentText}
        onSave={onEdit}
        onCancel={() => setEditing(false)}
        saving={savingEdit}
      />
    );
  }
  return (
    <div
      className="group flex w-full flex-col"
      onPointerDown={(event) => {
        if (event.pointerType !== "mouse") setActionsRevealed(true);
      }}
    >
      <TurnView message={message} />
      <AttachmentList attachments={message.attachments ?? []} align="left" />
      {(onRetry || onDelete || canEdit) && (
        <div
          className={cn(
            "pointer-events-none mt-2 flex opacity-0 transition-opacity duration-150 ease-out group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
            actionsRevealed && "pointer-events-auto opacity-100",
            latestAssistantActionPending && "pointer-events-auto opacity-100",
          )}
        >
          {retrying && <RetryDots />}
          {canEdit && (
            <ActionButton
              icon={SquarePen}
              label={savingEdit ? "saving edit" : "edit latest reply"}
              onClick={() => setEditing(true)}
              hoverClass="hover:text-foreground"
              disabled={latestAssistantActionPending}
            />
          )}
          {onRetry && (
            <ActionButton
              icon={RotateCcw}
              label={retrying ? "retry in progress" : "retry latest reply"}
              onClick={onRetry}
              hoverClass="hover:text-foreground"
              disabled={latestAssistantActionPending}
            />
          )}
          {onDelete && (
            <ActionButton
              icon={Trash2}
              label="delete latest reply"
              onClick={onDelete}
              hoverClass="hover:text-destructive"
              disabled={latestAssistantActionPending}
            />
          )}
        </div>
      )}
    </div>
  );
});
