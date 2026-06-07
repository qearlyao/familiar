import { ChevronLeft, ChevronRight, ExternalLink, Save, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type { GalleryItem } from "@/lib/api";
import { formatBytes, formatWhen } from "./format";
import { InkBloom } from "./InkBloom";
import { useAudioElement } from "./useAudioElement";

export interface GalleryNoteControls {
  draft: string;
  dirty: boolean;
  savingNote: boolean;
  noteSaved: boolean;
  noteError?: string;
  onDraftChange: (value: string) => void;
  onSave: () => void;
}

function noteStatusText({
  dirty,
  savingNote,
  noteSaved,
  noteError,
}: Pick<GalleryNoteControls, "dirty" | "savingNote" | "noteSaved" | "noteError">): string {
  if (savingNote) return "saving";
  if (noteError) return "save failed";
  if (dirty) return "unsaved";
  if (noteSaved) return "note kept";
  return "";
}

function NoteEditor({
  id,
  minHeightClassName,
  draft,
  onDraftChange,
}: {
  id: string;
  minHeightClassName: string;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  return (
    <>
      <label htmlFor={id} className="font-serif text-xs italic text-muted-foreground">
        your note
      </label>
      <Textarea
        id={id}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        placeholder="write a line about this one…"
        spellCheck
        className={`${minHeightClassName} resize-y rounded-md bg-background text-[0.95rem] leading-relaxed text-foreground`}
      />
    </>
  );
}

function NoteActions({
  item,
  note,
}: {
  item: GalleryItem;
  note: GalleryNoteControls;
}) {
  return (
    <>
      <span className="min-w-0 truncate font-serif text-xs italic text-muted-foreground">
        {noteStatusText(note)}
      </span>
      <div className="flex items-center gap-1">
        <Button asChild type="button" variant="ghost" size="icon-sm" title="open original" aria-label="open original">
          <a href={item.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" />
          </a>
        </Button>
        <Button type="button" size="sm" onClick={note.onSave} disabled={!note.dirty || note.savingNote}>
          <Save className="size-3.5" />
          {note.savingNote ? "saving" : "save note"}
        </Button>
      </div>
    </>
  );
}

export function AudioNotePopup({
  item,
  index,
  total,
  note,
  now,
}: {
  item: GalleryItem;
  index: number;
  total: number;
  note: GalleryNoteControls;
  now: number;
}) {
  const { audioRef, playing, toggle } = useAudioElement();
  const sizeLabel = formatBytes(item.size);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0 motion-reduce:animate-none" />
      <DialogPrimitive.Content
        className="fixed left-1/2 top-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-xl outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-reduce:animate-none"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogPrimitive.Title className="sr-only">
          recording from {formatWhen(item.createdAt, now)}
        </DialogPrimitive.Title>
        <audio ref={audioRef} src={item.url} preload="metadata" />

        <div className="gallery-audio-card flex flex-col items-center gap-4 px-6 pb-6 pt-8">
          <InkBloom id={item.id} playing={playing} onToggle={toggle} />
          <div className="flex flex-col items-center gap-1 text-center">
            <p className="font-serif text-sm italic leading-snug text-foreground">
              {formatWhen(item.createdAt, now)}
            </p>
            <p className="font-mono text-[0.7rem] text-muted-foreground">
              recording{sizeLabel ? ` · ${sizeLabel}` : ""} · {index + 1} of {total}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t border-border/70 px-6 py-4">
          <NoteEditor
            id="gallery-audio-note"
            minHeightClassName="min-h-24"
            draft={note.draft}
            onDraftChange={note.onDraftChange}
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/70 px-6 py-3">
          <NoteActions item={item} note={note} />
        </div>

        <DialogPrimitive.Close asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="close"
            title="close"
            className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </Button>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function Lightbox({
  item,
  index,
  total,
  note,
  now,
  onNavigate,
}: {
  item: GalleryItem;
  index: number;
  total: number;
  note: GalleryNoteControls;
  now: number;
  onNavigate: (delta: number) => void;
}) {
  const sizeLabel = formatBytes(item.size);
  const hasPrev = index > 0;
  const hasNext = index < total - 1;

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/95 data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0 motion-reduce:animate-none" />
      <DialogPrimitive.Content
        className="fixed inset-0 z-50 flex flex-col outline-none md:flex-row"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogPrimitive.Title className="sr-only">
          image from {formatWhen(item.createdAt, now)}
        </DialogPrimitive.Title>

        <div className="relative flex min-h-0 flex-1 items-center justify-center p-4 sm:p-8">
          {hasPrev ? (
            <button
              type="button"
              onClick={() => onNavigate(-1)}
              aria-label="previous piece"
              className="absolute left-2 top-1/2 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-card/90 text-foreground shadow-sm transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:left-4"
            >
              <ChevronLeft className="size-5" />
            </button>
          ) : null}

          <img
            src={item.url}
            alt={item.note || item.name}
            className="max-h-[calc(100dvh-2rem)] max-w-full rounded-md object-contain shadow-lg sm:max-h-[calc(100dvh-4rem)]"
          />

          {hasNext ? (
            <button
              type="button"
              onClick={() => onNavigate(1)}
              aria-label="next piece"
              className="absolute right-2 top-1/2 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-card/90 text-foreground shadow-sm transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:right-4"
            >
              <ChevronRight className="size-5" />
            </button>
          ) : null}
        </div>

        <aside className="flex max-h-[45dvh] shrink-0 flex-col border-t border-border bg-card md:max-h-none md:w-[22rem] md:border-l md:border-t-0">
          <div className="flex items-start justify-between gap-2 border-b border-border/70 px-5 py-4">
            <div className="min-w-0">
              <p className="font-serif text-sm italic leading-snug text-foreground">
                {formatWhen(item.createdAt, now)}
              </p>
              <p className="mt-1 truncate font-mono text-[0.7rem] text-muted-foreground">
                image{sizeLabel ? ` · ${sizeLabel}` : ""} · {index + 1} of {total}
              </p>
            </div>
            <DialogPrimitive.Close asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="close" title="close">
                <X className="size-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-2 px-5 py-4">
              <NoteEditor
                id="gallery-note"
                minHeightClassName="min-h-32"
                draft={note.draft}
                onDraftChange={note.onDraftChange}
              />
            </div>
          </ScrollArea>

          <div className="flex items-center justify-between gap-2 border-t border-border/70 px-5 py-3">
            <NoteActions item={item} note={note} />
          </div>
        </aside>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
