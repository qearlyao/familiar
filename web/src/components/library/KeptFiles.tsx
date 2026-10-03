import { useEffect, useState } from "react";
import remarkGfm from "remark-gfm";
import type { KeptFile } from "@/lib/api";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { IconExpand } from "../organicIcons";
import { noteAge } from "../reader/marginText";
import { ViewerDialog } from "../ViewerDialog";
import { ShelfItem } from "./ShelfItem";
import "../file-preview.css";

type Reading = "page" | "markdown" | "text";

const READINGS: Record<string, { reading: Reading; label: string }> = {
  "text/html": { reading: "page", label: "a page" },
  "application/xhtml+xml": { reading: "page", label: "a page" },
  "application/pdf": { reading: "page", label: "a pdf" },
  "text/markdown": { reading: "markdown", label: "notes" },
  "text/plain": { reading: "text", label: "text" },
  "text/csv": { reading: "text", label: "a table" },
  "application/json": { reading: "text", label: "data" },
};

const remarkPlugins = [remarkGfm];
const FAREWELL = "it leaves the shelf. it can always be sent again.";

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "file";
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shelfLine(file: KeptFile): string {
  const label = READINGS[file.mimeType]?.label ?? extensionOf(file.name);
  const when = file.updatedAt > file.createdAt ? `updated ${noteAge(file.updatedAt)}` : `left ${noteAge(file.createdAt)}`;
  return `${label} · ${when}`;
}

/** A loose sheet rather than a bound book: the file's kind on a tab, its name on the paper. */
function KeptCover({ file, className }: { file: KeptFile; className?: string }) {
  return (
    <span aria-hidden className={cn("library-kept-cover", className)}>
      <span className="library-kept-tab">{extensionOf(file.name).slice(0, 4)}</span>
      <span className="library-kept-name">{file.name.replace(/\.[^.]+$/, "")}</span>
    </span>
  );
}

function KeptText({ url, markdown }: { url: string; markdown: boolean }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    fetch(url)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`${res.status}`))))
      .then((body) => live && setText(body))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [url]);
  if (error) return <p className="viewer-error">couldn't open it · {error}</p>;
  if (text === undefined) return <p className="library-kept-loading">unfolding…</p>;
  return (
    <div className="library-kept-paper">
      {markdown ? (
        <MarkdownRenderer text={text} className="warm-prose chat-markdown" remarkPlugins={remarkPlugins} />
      ) : (
        <pre>{text}</pre>
      )}
    </div>
  );
}

function KeptTileBody({ file }: { file: KeptFile }) {
  return (
    <>
      <KeptCover file={file} className="library-shelf-cover" />
      <span className="library-shelf-copy">
        <strong>{file.name}</strong>
        <span>{shelfLine(file)}</span>
      </span>
    </>
  );
}

/** One kept file: pages, pdfs, notes and text open in the viewer; anything else downloads. */
export function KeptFileTile({ file, onRemove }: { file: KeptFile; onRemove: () => void }) {
  const reading = READINGS[file.mimeType];
  if (!reading) {
    return (
      <ShelfItem title={file.name} farewell={FAREWELL} onRemove={onRemove}>
        <a href={file.url} download={file.name} className="library-shelf-tile" title={`download ${file.name}`}>
          <KeptTileBody file={file} />
        </a>
      </ShelfItem>
    );
  }
  return (
    <ShelfItem title={file.name} farewell={FAREWELL} onRemove={onRemove}>
      {/* the span keeps the context menu and the viewer from fighting over one trigger */}
      <span className="contents">
        <ViewerDialog
          trigger={
            <button type="button" className="library-shelf-tile" aria-label={`open ${file.name}`}>
              <KeptTileBody file={file} />
            </button>
          }
          title={file.name}
          subtitle={`${reading.label} · ${fileSize(file.size)} · ${file.source}`}
          download={{ href: file.url, name: file.name }}
          closeLabel="back to the library"
          extraActions={
            <a className="viewer-ghost" href={file.url} target="_blank" rel="noopener noreferrer" aria-label="open in a new tab" title="open in a new tab">
              <IconExpand size={17} />
            </a>
          }
        >
          <div className="viewer-body">
            <div className="viewer-stage">
              <div className="viewer-frame">
                {reading.reading === "page" ? (
                  <iframe className="file-viewer-page" title={file.name} src={file.url} />
                ) : (
                  <KeptText url={file.url} markdown={reading.reading === "markdown"} />
                )}
              </div>
            </div>
          </div>
        </ViewerDialog>
      </span>
    </ShelfItem>
  );
}
