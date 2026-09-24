import { memo, useState } from "react";
import type { Attachment, Message } from "../types";
import { cn } from "@/lib/utils";
import { renderInlineText } from "@/lib/renderInlineText";
import { AudioPlayer } from "./AudioPlayer";
import { FileAttachmentCard } from "./FilePreview";
import { MediaPreview, type PreviewMedia } from "./MediaPreview";
import { TurnView } from "./TurnView";
import { ErrorNotice } from "./steps/ErrorNotice";
import { withoutSilentMarker } from "@/lib/silentMarker";
import { IconAgain, IconCheck, IconChevronDown, IconChevronUp, IconClock, IconEdit, IconFern, IconMic, IconX } from "./organicIcons";

type ImageAttachment = Attachment & { url: string };

function isImage(attachment: Attachment): attachment is ImageAttachment {
  return Boolean(attachment.url) && (attachment.kind === "image" || attachment.mimeType?.startsWith("image/") === true);
}

function isMedia(attachment: Attachment): boolean {
  return isImage(attachment) || attachment.mimeType?.startsWith("video/") === true;
}

function DerivedText({ derived }: { derived: NonNullable<Attachment["derivedText"]> }) {
  return (
    <div className="chat-attachment-context">
      {derived.label ? <small>{derived.label}</small> : null}
      <span>{derived.text}</span>
    </div>
  );
}

function VoiceAttachment({ src, name, spoken }: { src: string; name?: string; spoken?: string }) {
  const [showWords, setShowWords] = useState(false);
  return (
    <>
      <AudioPlayer src={src} name={name} />
      {spoken && (
        <>
          <button type="button" className="chat-words-toggle" aria-expanded={showWords} onClick={() => setShowWords((open) => !open)}>
            {showWords ? <IconChevronUp size={13} /> : <IconChevronDown size={13} />}
            <span>{showWords ? "hide the words" : "read the words"}</span>
          </button>
          {showWords && <p className="chat-spoken-words">{spoken}</p>}
        </>
      )}
    </>
  );
}

function AttachmentItem({ attachment, media }: { attachment: Attachment; media: PreviewMedia[] }) {
  if (!attachment.url) return null;
  if (isImage(attachment)) {
    return <MediaPreview src={attachment.url} alt={attachment.name} items={media} className="chat-media-frame" imageClassName="w-full rounded-[16px] object-cover" />;
  }
  if (attachment.mimeType?.startsWith("video/")) {
    return <MediaPreview src={attachment.url} alt={attachment.name} kind="video" items={media} className="chat-media-frame" />;
  }
  if (attachment.mimeType?.startsWith("audio/")) {
    return (
      <VoiceAttachment
        src={attachment.url}
        name={attachment.name}
        spoken={attachment.derivedText?.label === "spoken" ? attachment.derivedText.text : undefined}
      />
    );
  }
  return <FileAttachmentCard attachment={attachment} url={attachment.url} />;
}

function Attachments({ attachments }: { attachments: Attachment[] }) {
  const media: PreviewMedia[] = attachments.flatMap((item) => item.url && isMedia(item) ? [{ src: item.url, name: item.name, kind: isImage(item) ? "image" : "video" }] : []);
  const images = attachments.filter(isImage);
  const album = images.length >= 2;
  return (
    <>
      {album && (
        <div className="chat-image-album">
          {images.map((image) => (
            <div key={image.id}>
              <MediaPreview src={image.url} alt={image.name} items={media} className="block h-full w-full" imageClassName="h-full w-full max-h-none object-cover rounded-none" />
            </div>
          ))}
        </div>
      )}
      {attachments.map((attachment) =>
        album && isImage(attachment) ? null : <AttachmentItem key={attachment.id} attachment={attachment} media={media} />,
      )}
    </>
  );
}

function messageText(message: Message): string {
  return message.steps.map((step) => (step.kind === "text" ? step.text : "")).join("");
}

function UserTurn({ message }: { message: Message }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const text = messageText(message);
  const attachments = message.attachments ?? [];
  const hasMedia = attachments.some((a) => a.url && isMedia(a));
  const derived = attachments.filter((a) => a.derivedText);
  const transcripts = derived.filter((a) => a.mimeType?.startsWith("audio/") && a.derivedText?.label !== "spoken");
  return (
    <div className="chat-user-turn">
      <span className="sr-only">{message.who}</span>
      <div className={cn("chat-user-bubble", hasMedia && "has-media")}>
        <Attachments attachments={attachments} />
        {transcripts.length > 0 && (
          <button
            type="button"
            className="chat-transcribed"
            aria-expanded={showTranscript}
            onClick={() => setShowTranscript((open) => !open)}
          >
            <IconMic size={12} /> <span>transcribed</span>
          </button>
        )}
        {text && renderInlineText(text, { align: "end" })}
      </div>
      {derived
        .filter((a) => showTranscript || !transcripts.includes(a))
        .map((a) => (
          <DerivedText key={`${a.id}-derived`} derived={a.derivedText!} />
        ))}
    </div>
  );
}

function EditForm({ initialText, onSave, onCancel, saving }: { initialText: string; onSave?: (text: string) => Promise<void>; onCancel: () => void; saving: boolean }) {
  const [text, setText] = useState(initialText);
  return (
    <div className="chat-assistant-turn chat-edit">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.max(3, Math.min(12, text.split("\n").length))} autoFocus />
      <div className="chat-message-actions">
        <button type="button" className="chat-action" disabled={saving || !text.trim()} onClick={() => void onSave?.(text).then(onCancel, () => undefined)}>
          <IconCheck /> {saving ? "saving…" : "keep"}
        </button>
        <button type="button" className="chat-action" disabled={saving} onClick={onCancel}>
          <IconX /> never mind
        </button>
      </div>
    </div>
  );
}

function SystemRow({ message, text, live }: { message: Message; text: string; live?: boolean }) {
  switch (message.notice) {
    case "heartbeat":
    case "cron":
      return (
        <div className={live ? "chat-notice-pill is-live" : "chat-notice-pill"}>
          {message.notice === "cron" ? <IconClock size={12} /> : <IconFern size={12} />}
          {message.notice === "cron" ? `cron · ${text}` : "heartbeat"}
        </div>
      );
    case "reset":
      return <div className="chat-page-break">a fresh page</div>;
    case "error":
      return <ErrorNotice label="something slipped" text={text} />;
    default:
      return text ? <p className="chat-system">{text}</p> : null;
  }
}

export const MessageBubble = memo(function MessageBubble({
  message,
  onRetry,
  onDelete,
  onEdit,
  pendingLatestAssistantAction,
  live,
}: {
  message: Message;
  onRetry?: () => void;
  onDelete?: () => void;
  onEdit?: (text: string) => Promise<void>;
  pendingLatestAssistantAction?: "retry" | "delete" | "edit";
  /** a heartbeat or cron pill still breathes while he's waking */
  live?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const pending = pendingLatestAssistantAction != null;
  const text = messageText(message);
  const canEdit = !!onEdit && !!text.trim();

  if (message.role === "system") return <SystemRow message={message} text={text} live={live} />;
  if (message.role === "user") return <UserTurn message={message} />;
  if (editing) return <EditForm initialText={text} onSave={onEdit} onCancel={() => setEditing(false)} saving={pendingLatestAssistantAction === "edit"} />;

  // marker-only silence: whatever steps ran sit above, the quiet note beneath.
  // silence with words left over falls through and renders muted (see TextStep).
  if (message.silent && !withoutSilentMarker(text) && !message.steps.some((s) => s.kind === "error")) {
    return (
      <>
        <TurnView message={message} />
        <div className="chat-silent">
          <span className="chat-speaker">{message.who}</span>
          <em>stayed quiet for a moment.</em>
        </div>
      </>
    );
  }

  const attachments = message.attachments ?? [];
  // A turn that has only tool steps so far (tts/image_gen still running) gets no speaker block of its own.
  const hasBody = message.steps.some((step) => (step.kind === "text" && withoutSilentMarker(step.text)) || step.kind === "error");
  const showActions = (onRetry || onDelete || canEdit) && (hasBody || attachments.length > 0);
  if (attachments.length === 0 && !showActions) return <TurnView message={message} />;
  return (
    <TurnView message={message}>
      <Attachments attachments={attachments} />
      {showActions && (
        <div className="chat-message-actions">
          {pendingLatestAssistantAction === "retry" && (
            <span className="chat-retrying">
              retrying
              {[0, 1, 2].map((i) => (
                <i key={i} style={{ animationDelay: `${i * 140}ms` }} />
              ))}
            </span>
          )}
          {onRetry && (
            <button type="button" className="chat-action" disabled={pending} onClick={onRetry} title="say it again">
              <IconAgain /> again
            </button>
          )}
          {canEdit && (
            <button type="button" className="chat-action" disabled={pending} onClick={() => setEditing(true)} title="edit the latest reply">
              <IconEdit /> edit
            </button>
          )}
          {onDelete && (
            <button type="button" className="chat-action" disabled={pending} onClick={onDelete} title="let it go">
              <IconX /> let go
            </button>
          )}
        </div>
      )}
    </TurnView>
  );
});
