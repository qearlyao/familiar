import { Palette, Pencil, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GalleryItem } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatDuration, formatShortDate, type TimeGroup } from "./format";
import { InkBloom } from "./InkBloom";
import { useAudioElement } from "./useAudioElement";

function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-4 flex items-baseline gap-3">
      <h2 className="font-serif text-lg leading-none tracking-tight text-foreground">{label}</h2>
      <span className="font-serif text-xs italic text-muted-foreground">
        {count} {count === 1 ? "piece" : "pieces"}
      </span>
      <span className="h-px flex-1 bg-border/70" aria-hidden />
    </div>
  );
}

export function NoteMark({ note }: { note: string }) {
  return (
    <span className="mt-1 flex items-start gap-1.5">
      <span className="mt-[0.45rem] size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
      <span className="line-clamp-2 font-serif text-[0.72rem] italic leading-snug text-muted-foreground">{note}</span>
    </span>
  );
}

function ImageTile({ item, onOpen }: { item: GalleryItem; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/tile mb-3 block w-full break-inside-avoid text-left focus-visible:outline-none"
      aria-label={`open image from ${formatShortDate(item.createdAt)}`}
    >
      <span
        className={cn(
          "block overflow-hidden rounded-md border border-border bg-card p-1 shadow-xs",
          "transition-[transform,box-shadow] duration-200 ease-out motion-reduce:transition-none",
          "group-hover/tile:-translate-y-0.5 group-hover/tile:shadow-md",
          "group-focus-visible/tile:ring-3 group-focus-visible/tile:ring-ring/50",
        )}
      >
        <img
          src={item.url}
          alt={item.note || item.name}
          loading="lazy"
          className="block h-auto w-full rounded-sm bg-muted object-cover"
        />
      </span>
      <span className="mt-1.5 flex flex-col px-0.5">
        <span className="font-serif text-[0.7rem] italic text-muted-foreground/80">
          {formatShortDate(item.createdAt)}
        </span>
        {item.note ? <NoteMark note={item.note} /> : null}
      </span>
    </button>
  );
}

function AudioTile({ item, onOpenNote }: { item: GalleryItem; onOpenNote: () => void }) {
  const { audioRef, playing, duration, toggle } = useAudioElement();
  const durationLabel = formatDuration(duration);
  return (
    <div className="mb-3 break-inside-avoid">
      <audio ref={audioRef} src={item.url} preload="metadata" />
      <div className="gallery-audio-card flex flex-col rounded-3xl px-3 pb-3 pt-3">
        <div className="grid place-items-center py-1">
          <InkBloom id={item.id} playing={playing} onToggle={toggle} />
        </div>
        <div className="mt-2 flex flex-col gap-1 px-1">
          <span className="font-serif text-sm italic leading-none text-muted-foreground tabular-nums">
            {durationLabel ?? "a recording"}
          </span>
          <button
            type="button"
            onClick={onOpenNote}
            aria-label={item.note ? "open note" : "add a note"}
            className="rounded-sm text-left transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
          >
            {item.note ? (
              <NoteMark note={item.note} />
            ) : (
              <span className="flex items-center gap-1 font-serif text-[0.72rem] italic text-muted-foreground/60 hover:text-foreground">
                <Pencil className="size-3" />
                add a note
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GalleryGrid({
  groups,
  onOpen,
}: {
  groups: TimeGroup[];
  onOpen: (index: number) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
      {groups.map((group) => (
        <section key={group.key} className="mb-9 last:mb-2">
          <GroupHeading label={group.label} count={group.entries.length} />
          <div className="columns-2 gap-3 sm:columns-3 lg:columns-4">
            {group.entries.map(({ item, index }) =>
              item.kind === "audio" ? (
                <AudioTile key={item.id} item={item} onOpenNote={() => onOpen(index)} />
              ) : (
                <ImageTile key={item.id} item={item} onOpen={() => onOpen(index)} />
              ),
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

export function GallerySkeleton() {
  const spans = [40, 26, 34, 30, 44, 28, 36, 32, 40, 24, 30, 38];
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8" aria-hidden>
      <div className="mb-4 h-4 w-28 rounded-sm bg-muted-foreground/15" />
      <div className="columns-2 gap-3 sm:columns-3 lg:columns-4">
        {spans.map((h, i) => (
          <div key={i} className="mb-3 break-inside-avoid rounded-md border border-border bg-card p-1">
            <div className="rounded-sm bg-muted-foreground/10" style={{ height: `${h * 4}px` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function EmptyGallery({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="flex h-full min-h-[18rem] items-center justify-center px-6 text-center">
      <div className="max-w-sm">
        <Palette className="mx-auto size-7 text-muted-foreground" />
        <h2 className="mt-5 font-serif text-xl leading-tight tracking-tight">nothing made yet</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          when familiar draws something or records a sound, it will be kept here for you to look back on.
        </p>
        <Button type="button" variant="ghost" className="mt-5" onClick={onRefresh}>
          <RefreshCw className="size-4" />
          look again
        </Button>
      </div>
    </div>
  );
}
