import { useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Pause, Play, Save, X } from "lucide-react";
import { Dialog as DialogPrimitive, Popover as PopoverPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { GalleryItem } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatBytes, formatDuration, formatWhen } from "./format";
import { bloomPulseForId, InkBloomField } from "./InkBloom";
import { useAudioElement } from "./useAudioElement";

export interface GalleryNoteControls {
  draft: string;
  dirty: boolean;
  savingNote: boolean;
  noteSaved: boolean;
  noteError?: string;
  onDraftChange: (value: string) => void;
  onSave: () => boolean | Promise<boolean>;
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

function NotePopup({
  item,
  note,
}: {
  item: GalleryItem;
  note: GalleryNoteControls;
}) {
  const [open, setOpen] = useState(false);
  const status = noteStatusText(note);
  const cancel = () => {
    note.onDraftChange(item.note);
    setOpen(false);
  };
  const save = async () => {
    if (!note.dirty) {
      setOpen(false);
      return;
    }
    if (await note.onSave()) setOpen(false);
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 font-serif text-xs italic text-muted-foreground hover:text-foreground"
        >
          add a note
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="center"
          sideOffset={8}
          collisionPadding={16}
          className={cn(
            "z-[60] w-72 rounded-md border border-border bg-card p-3 text-card-foreground shadow-lg",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
            "motion-reduce:animate-none",
          )}
        >
          <Textarea
            value={note.draft}
            onChange={(event) => note.onDraftChange(event.target.value)}
            placeholder="write a line about this one..."
            spellCheck
            className="min-h-20 resize-none rounded-md bg-background text-sm leading-relaxed text-foreground"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-serif text-xs italic text-muted-foreground">{status}</span>
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={note.savingNote}>
                cancel
              </Button>
              <Button type="button" size="sm" onClick={() => void save()} disabled={!note.dirty || note.savingNote}>
                <Save className="size-3.5" />
                {note.savingNote ? "saving" : "keep note"}
              </Button>
            </div>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function AudioProgress({
  duration,
  currentTime,
  playing,
  onToggle,
  onSeek,
}: {
  duration: number | undefined;
  currentTime: number;
  playing: boolean;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
}) {
  const knownDuration = duration && Number.isFinite(duration) && duration > 0 ? duration : undefined;
  const elapsed = knownDuration ? Math.min(knownDuration, Math.max(0, currentTime)) : 0;
  const percent = knownDuration ? `${(elapsed / knownDuration) * 100}%` : "0%";

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={(event) => {
          if (!knownDuration) {
            onToggle();
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / rect.width;
          onSeek(knownDuration * ratio);
        }}
        aria-label="seek recording"
        className="group/progress flex h-8 w-full items-center rounded-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
      >
        <span className="relative block h-px w-full bg-border">
          <span className="absolute inset-y-0 left-0 bg-primary" style={{ width: percent }} />
          <span
            className={cn(
              "absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary",
              "transition-[transform,opacity] duration-200 ease-out group-hover/progress:scale-125",
              playing ? "opacity-100" : "opacity-70",
            )}
            style={{ left: percent }}
          />
        </span>
      </button>
      <div className="mt-0.5 flex items-center justify-between font-serif text-[0.7rem] italic text-muted-foreground/80 tabular-nums">
        <span>{formatDuration(elapsed) ?? "0:00"}</span>
        <button
          type="button"
          onClick={onToggle}
          aria-label={playing ? "pause recording" : "play recording"}
          className="inline-flex h-6 items-center gap-1 rounded-sm px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
        >
          {playing ? (
            <Pause className="size-3 fill-current" strokeWidth={0} />
          ) : (
            <Play className="size-3 translate-x-px fill-current" strokeWidth={0} />
          )}
          <span>{playing ? "pause" : "play"}</span>
        </button>
        <span>{formatDuration(knownDuration) ?? "0:00"}</span>
      </div>
    </div>
  );
}

function AudioLightboxContent({
  item,
  note,
}: {
  item: GalleryItem;
  note: GalleryNoteControls;
}) {
  const { audioRef, playing, duration, currentTime, toggle, seek } = useAudioElement();

  return (
    <div className="flex h-full w-full max-w-4xl flex-col items-center justify-center">
      <audio ref={audioRef} src={item.url} preload="metadata" />
      <div className="grid min-h-0 flex-1 place-items-center py-4">
        <InkBloomField
          id={item.id}
          playing={playing}
          pulse={bloomPulseForId(item.id)}
          className="size-[min(50vmin,24rem)]"
          scaleOffset={0.12}
        />
      </div>
      <div className="w-full max-w-2xl pb-4 md:pb-8">
        <AudioProgress duration={duration} currentTime={currentTime} playing={playing} onToggle={toggle} onSeek={seek} />
        {note.draft ? (
          <p className="mx-auto mt-4 max-w-xl text-center font-serif text-sm italic leading-relaxed text-muted-foreground">
            {note.draft}
          </p>
        ) : null}
        <div className="mt-2 flex justify-center">
          <NotePopup item={item} note={note} />
        </div>
      </div>
    </div>
  );
}

function ImageLightboxContent({
  item,
  note,
}: {
  item: GalleryItem;
  note: GalleryNoteControls;
}) {
  return (
    <div className="flex h-full w-full max-w-5xl flex-col items-center justify-center gap-3">
      <img
        src={item.url}
        alt={note.draft || item.name}
        className="min-h-0 max-h-[calc(100dvh-11rem)] max-w-full rounded-md object-contain shadow-lg"
      />
      <div className="pb-4">
        <NotePopup item={item} note={note} />
      </div>
    </div>
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
  const kindLabel = item.kind === "audio" ? "recording" : "image";

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0 motion-reduce:animate-none" />
      <DialogPrimitive.Content
        className="fixed inset-0 z-50 flex flex-col bg-background text-foreground outline-none"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogPrimitive.Title className="sr-only">
          {kindLabel} from {formatWhen(item.createdAt, now)}
        </DialogPrimitive.Title>

        <div className="flex items-center justify-between border-b border-border/70 px-3 py-3 md:px-6">
          <div className="min-w-0">
            <p className="font-serif text-sm italic leading-snug text-foreground">
              {kindLabel} · {formatWhen(item.createdAt, now)}
            </p>
            <p className="mt-0.5 font-serif text-[0.7rem] italic text-muted-foreground">
              {index + 1} of {total}
              {sizeLabel ? ` · ${sizeLabel}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button asChild type="button" variant="ghost" size="icon-sm" title="open original" aria-label="open original">
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
              </a>
            </Button>
            <DialogPrimitive.Close asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="close" title="close">
                <X className="size-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 py-5 md:px-12">
          {hasPrev ? (
            <button
              type="button"
              onClick={() => onNavigate(-1)}
              aria-label="previous piece"
              className="absolute left-2 top-1/2 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-card/90 text-foreground shadow-sm transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:left-5"
            >
              <ChevronLeft className="size-5" />
            </button>
          ) : null}

          {item.kind === "audio" ? (
            <AudioLightboxContent item={item} note={note} />
          ) : (
            <ImageLightboxContent item={item} note={note} />
          )}

          {hasNext ? (
            <button
              type="button"
              onClick={() => onNavigate(1)}
              aria-label="next piece"
              className="absolute right-2 top-1/2 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-card/90 text-foreground shadow-sm transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:right-5"
            >
              <ChevronRight className="size-5" />
            </button>
          ) : null}
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
