import { useRef } from "react";
import { Dialog } from "radix-ui";
import type { Attachment } from "../types";
import { focusPanel } from "@/lib/focusPanel";
import { IconDownload, IconExpand, IconPaperclip, IconX } from "./organicIcons";
import "./file-preview.css";

type PreviewKind = "html" | "pdf";

function previewKind(attachment: Attachment): PreviewKind | undefined {
  const type = attachment.mimeType?.split(";")[0].trim().toLowerCase();
  if (type === "text/html") return "html";
  if (type === "application/pdf") return "pdf";
  return undefined;
}

const KIND_LABELS: Record<PreviewKind, string> = { html: "a page", pdf: "a pdf" };

function fileSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "FILE";
}

function Stage({ attachment, url }: { attachment: Attachment; url: string }) {
  return (
    <div className="viewer-stage">
      <div className="viewer-frame file-viewer-frame">
        <iframe className="file-viewer-page" title={attachment.name} src={url} />
      </div>
    </div>
  );
}

function FileCardBody({ attachment, action }: { attachment: Attachment; action: string }) {
  const size = fileSize(attachment.size);
  return (
    <>
      <span className="chat-file-badge" aria-hidden="true">{extensionOf(attachment.name).slice(0, 4)}</span>
      <span className="chat-file-text">
        <span className="chat-file-name">{attachment.name}</span>
        <span className="chat-file-meta">{size ? `${size} · ${action}` : action}</span>
      </span>
      <IconPaperclip size={15} className="chat-file-clip" />
    </>
  );
}

/** a file that isn't a picture, clip, or voice: a card to open (pages, pdfs) or download (the rest) */
export function FileAttachmentCard({ attachment, url }: { attachment: Attachment; url: string }) {
  const kind = previewKind(attachment);
  const closedByKey = useRef(false);
  if (!kind) {
    return (
      <a href={url} download={attachment.name} className="chat-file-card">
        <FileCardBody attachment={attachment} action="download" />
      </a>
    );
  }
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" className="chat-file-card" aria-label={`open ${attachment.name}`}>
          <FileCardBody attachment={attachment} action="open" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="viewer-overlay" />
        <Dialog.Content
          className="viewer file-viewer chat-theme"
          aria-describedby={undefined}
          onOpenAutoFocus={focusPanel}
          onCloseAutoFocus={(event) => {
            if (!closedByKey.current) event.preventDefault();
            closedByKey.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") closedByKey.current = true;
          }}
        >
          <header className="viewer-head">
            <Dialog.Close className="viewer-ghost viewer-close-top" aria-label="back to the thread"><IconX size={18} /></Dialog.Close>
            <span className="viewer-title">
              <Dialog.Title title={attachment.name}>{attachment.name}</Dialog.Title>
              <p>{KIND_LABELS[kind]}{fileSize(attachment.size) ? ` · ${fileSize(attachment.size)}` : ""}</p>
            </span>
          </header>

          <div className="viewer-actions">
            <a className="viewer-accent" href={url} download={attachment.name} title="download the original">
              <IconDownload size={16} /> download
            </a>
            <a className="viewer-ghost" href={url} target="_blank" rel="noopener noreferrer" aria-label="open in a new tab" title="open in a new tab">
              <IconExpand size={17} />
            </a>
            <Dialog.Close className="viewer-ghost viewer-close-side" aria-label="close"><IconX size={18} /></Dialog.Close>
          </div>

          <div className="viewer-body">
            <Stage attachment={attachment} url={url} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
