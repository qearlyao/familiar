import { useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Pause, Play, Save, X } from "lucide-react";
import { Dialog as DialogPrimitive, Popover as PopoverPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { GalleryItem } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatBytes, formatDuration, formatWhen } from "./format";
import { InkBloomField } from "./InkBloom";
import { bloomPulseForId } from "./inkBloomModel";
import { useAudioElement } from "./useAudioElement";

export interface GalleryNoteControls {
  text: string;
  savingNote: boolean;
  noteSaved: boolean;
  noteError?: string;
  onSave: (text: string) => boolean | Promise<boolean>;
}

function noteStatusText({
  savingNote,
  noteSaved,
  noteError,
  dirty,
}: Pick<GalleryNoteControls, "savingNote" | "noteSaved" | "noteError"> & { dirty: boolean }): string {
  if (savingNote) return "saving";
  if (dirty) return "unsaved";
  if (noteError) return "save failed";
  if (noteSaved) return "note kept";
  return "";
}

function NotePopup({
  note,
}: {
  note: GalleryNoteControls;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const dirty = draft !== note.text;
  const status = noteStatusText({ ...note, dirty });
  const cancel = () => {
    setDraft(note.text);
    setOpen(false);
  };
  const save = async () => {
    if (!dirty) {
      setOpen(false);
      return;
    }
    if (await note.onSave(draft)) setOpen(false);
  };

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setDraft(note.text);
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 font-serif text-xs italic text-muted-foreground hover:text-foreground"
        >
          {note.text ? "edit note" : "add a note"}
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
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
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
              <Button type="button" size="sm" onClick={() => void save()} disabled={!dirty || note.savingNote}>
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
  const percent = knownDuration ? (elapsed / knownDuration) * 100 : 0;

  return (
    <div className="w-full">
      <div className="relative h-8 w-full rounded-sm focus-within:ring-3 focus-within:ring-ring/40">
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border/80">
          <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          <span
            className={cn(
              "absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary transition-[transform,opacity] duration-200 ease-out",
              playing ? "opacity-100" : "opacity-70",
            )}
            style={{ left: `${percent}%` }}
          />
        </div>
        <input
          type="range"
          min={0}
          max={knownDuration ?? 0}
          step={0.1}
          value={elapsed}
          onChange={(event) => onSeek(Number(event.target.value))}
          aria-label="seek recording"
          disabled={!knownDuration}
          className="absolute inset-0 z-10 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 outline-none disabled:cursor-default"
        />
      </div>
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
        {note.text ? (
          <p className="mx-auto mt-4 max-w-xl text-center font-serif text-sm italic leading-relaxed text-muted-foreground">
            {note.text}
          </p>
        ) : null}
        <div className="mt-2 flex justify-center">
          <NotePopup key={item.id} note={note} />
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
        alt={note.text || item.name}
        className="min-h-0 max-h-[calc(100dvh-11rem)] max-w-full rounded-md object-contain shadow-lg"
      />
      <div className="pb-4">
        <NotePopup key={item.id} note={note} />
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
