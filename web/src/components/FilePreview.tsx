import type { Attachment } from "../types";
import { IconExpand, IconPaperclip } from "./organicIcons";
import { ViewerDialog } from "./ViewerDialog";
import "./file-preview.css";

/** what the viewer calls a file it can open in place; anything else only downloads */
function previewLabel(attachment: Attachment): string | undefined {
  const type = attachment.mimeType?.split(";")[0].trim().toLowerCase();
  if (type === "text/html") return "a page";
  if (type === "application/pdf") return "a pdf";
  return undefined;
}

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

function FileCardBody({ name, meta }: { name: string; meta: string }) {
  return (
    <>
      <span className="chat-file-badge" aria-hidden="true">{extensionOf(name).slice(0, 4)}</span>
      <span className="chat-file-text">
        <span className="chat-file-name">{name}</span>
        <span className="chat-file-meta">{meta}</span>
      </span>
      <IconPaperclip size={15} className="chat-file-clip" />
    </>
  );
}

/** a file that isn't a picture, clip, or voice: a card to open (pages, pdfs) or download (the rest) */
export function FileAttachmentCard({ attachment, url }: { attachment: Attachment; url: string }) {
  const label = previewLabel(attachment);
  const size = fileSize(attachment.size);
  const withSize = (text: string) => (size ? `${size} · ${text}` : text);
  if (!label) {
    return (
      <a href={url} download={attachment.name} className="chat-file-card">
        <FileCardBody name={attachment.name} meta={withSize("download")} />
      </a>
    );
  }
  return (
    <ViewerDialog
      trigger={
        <button type="button" className="chat-file-card" aria-label={`open ${attachment.name}`}>
          <FileCardBody name={attachment.name} meta={withSize("open")} />
        </button>
      }
      title={attachment.name}
      subtitle={size ? `${label} · ${size}` : label}
      download={{ href: url, name: attachment.name }}
      extraActions={
        <a className="viewer-ghost" href={url} target="_blank" rel="noopener noreferrer" aria-label="open in a new tab" title="open in a new tab">
          <IconExpand size={17} />
        </a>
      }
    >
      <div className="viewer-body">
        <div className="viewer-stage">
          <div className="viewer-frame">
            <iframe className="file-viewer-page" title={attachment.name} src={url} />
          </div>
        </div>
      </div>
    </ViewerDialog>
  );
}
