import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Palette,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { fetchGallery, saveGalleryNote, type GalleryItem } from "@/lib/api";
import { cn } from "@/lib/utils";

const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const TIME_OF_DAY = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const LONG_DATE = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const LONG_DATE_YEAR = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});
const MONTH = new Intl.DateTimeFormat(undefined, { month: "long" });
const MONTH_YEAR = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatShortDate(ms: number): string {
  return SHORT_DATE.format(new Date(ms)).toLowerCase();
}

function formatWhen(ms: number, now: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const datePart = (sameYear ? LONG_DATE : LONG_DATE_YEAR).format(d);
  return `${datePart} · ${TIME_OF_DAY.format(d)}`.toLowerCase();
}

function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || bytes <= 0) return undefined;
  if (bytes < 1024) return `${bytes} b`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} kb`;
  return `${(kb / 1024).toFixed(1)} mb`;
}

function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

// Deterministic per-id variation so no two blooms read the same shape.
function bloomFieldStyle(id: string): CSSProperties {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const seed = Math.abs(hash);
  const rotation = seed % 360;
  const scale = 0.86 + ((seed >> 4) % 30) / 100;
  return { transform: `rotate(${rotation}deg) scale(${scale})` };
}

function InkBloom({
  id,
  playing,
  onToggle,
}: {
  id: string;
  playing: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={playing ? "pause recording" : "play recording"}
      className={cn("bloom group/bloom size-20", playing && "is-playing")}
    >
      <span className="bloom-field" style={bloomFieldStyle(id)} aria-hidden>
        <span className="bloom-blob bloom-blob-a" />
        <span className="bloom-blob bloom-blob-b" />
        <span className="bloom-blob bloom-blob-c" />
        <span className="bloom-blob bloom-blob-d" />
      </span>
      <span className="bloom-glyph">
        {playing ? (
          <Pause className="size-5 fill-current" strokeWidth={0} />
        ) : (
          <Play className="size-5 translate-x-px fill-current" strokeWidth={0} />
        )}
      </span>
    </button>
  );
}

// Drives an <audio> element and reports play state + resolved duration. Used by
// the audio tile and the audio note popup, each rendering their own <audio>.
function useAudioElement(): {
  audioRef: React.RefCallback<HTMLAudioElement>;
  playing: boolean;
  duration: number | undefined;
  toggle: () => void;
} {
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const detachAudioListenersRef = useRef<(() => void) | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number>();

  const syncPlaybackState = useCallback((el = audioElementRef.current) => {
    setPlaying(Boolean(el && !el.paused && !el.ended));
  }, []);

  const syncDuration = useCallback((el = audioElementRef.current) => {
    setDuration(el && Number.isFinite(el.duration) ? el.duration : undefined);
  }, []);

  const audioRef = useCallback(
    (el: HTMLAudioElement | null) => {
      detachAudioListenersRef.current?.();
      detachAudioListenersRef.current = undefined;
      audioElementRef.current = el;

      if (!el) {
        setPlaying(false);
        return;
      }

      const onMeta = () => syncDuration(el);
      const onPlayback = () => syncPlaybackState(el);
      onMeta();
      onPlayback();
      el.addEventListener("loadedmetadata", onMeta);
      el.addEventListener("durationchange", onMeta);
      el.addEventListener("play", onPlayback);
      el.addEventListener("playing", onPlayback);
      el.addEventListener("pause", onPlayback);
      el.addEventListener("ended", onPlayback);
      el.addEventListener("emptied", onPlayback);
      detachAudioListenersRef.current = () => {
        el.removeEventListener("loadedmetadata", onMeta);
        el.removeEventListener("durationchange", onMeta);
        el.removeEventListener("play", onPlayback);
        el.removeEventListener("playing", onPlayback);
        el.removeEventListener("pause", onPlayback);
        el.removeEventListener("ended", onPlayback);
        el.removeEventListener("emptied", onPlayback);
      };
    },
    [syncDuration, syncPlaybackState],
  );

  useEffect(() => {
    return () => detachAudioListenersRef.current?.();
  }, []);

  const toggle = useCallback(() => {
    const el = audioElementRef.current;
    if (!el) return;
    if (!el.paused && !el.ended) {
      el.pause();
      syncPlaybackState(el);
      return;
    }
    if (el.ended) el.currentTime = 0;
    setPlaying(true);
    void el.play().then(() => syncPlaybackState(el)).catch(() => syncPlaybackState(el));
  }, [syncPlaybackState]);

  return { audioRef, playing, duration, toggle };
}

interface TimeGroup {
  key: string;
  label: string;
  entries: { item: GalleryItem; index: number }[];
}

function groupByTime(items: GalleryItem[], now: number): TimeGroup[] {
  const today = startOfDay(now);
  const groups: TimeGroup[] = [];
  const byKey = new Map<string, TimeGroup>();

  const push = (key: string, label: string, item: GalleryItem, index: number) => {
    let group = byKey.get(key);
    if (!group) {
      group = { key, label, entries: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.entries.push({ item, index });
  };

  items.forEach((item, index) => {
    const day = startOfDay(item.createdAt);
    if (day >= today) {
      push("today", "today", item, index);
    } else if (day >= today - DAY_MS) {
      push("yesterday", "yesterday", item, index);
    } else if (day >= today - 6 * DAY_MS) {
      push("this-week", "earlier this week", item, index);
    } else {
      const d = new Date(item.createdAt);
      const sameYear = d.getFullYear() === new Date(now).getFullYear();
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const label = (sameYear ? MONTH : MONTH_YEAR).format(d).toLowerCase();
      push(key, label, item, index);
    }
  });

  return groups;
}

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

function NoteMark({ note }: { note: string }) {
  return (
    <span className="mt-1 flex items-start gap-1.5">
      <span className="mt-[0.45rem] size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
      <span className="line-clamp-2 font-serif text-[0.72rem] italic leading-snug text-muted-foreground">
        {note}
      </span>
    </span>
  );
}

function ImageTile({ item, onOpen }: { item: GalleryItem; onOpen: () => void }) {
  const ratio = item.width && item.height ? item.width / item.height : undefined;
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
          width={item.width}
          height={item.height}
          style={ratio ? { aspectRatio: `${item.width} / ${item.height}` } : undefined}
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

function GalleryGrid({
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

function GallerySkeleton() {
  const spans = [40, 26, 34, 30, 44, 28, 36, 32, 40, 24, 30, 38];
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8" aria-hidden>
      <div className="mb-4 h-4 w-28 rounded-sm bg-muted-foreground/15" />
      <div className="columns-2 gap-3 sm:columns-3 lg:columns-4">
        {spans.map((h, i) => (
          <div
            key={i}
            className="mb-3 break-inside-avoid rounded-md border border-border bg-card p-1"
          >
            <div className="rounded-sm bg-muted-foreground/10" style={{ height: `${h * 4}px` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyGallery({ onRefresh }: { onRefresh: () => void }) {
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

// Audio doesn't get the full split lightbox — clicking "add a note" on a tile
// opens this small centered window: the bloom plays inline, with the same
// when/meta detail and note machinery as the image lightbox, just compact.
function AudioNotePopup({
  item,
  index,
  total,
  draft,
  dirty,
  savingNote,
  noteSaved,
  now,
  onDraftChange,
  onSave,
}: {
  item: GalleryItem;
  index: number;
  total: number;
  draft: string;
  dirty: boolean;
  savingNote: boolean;
  noteSaved: boolean;
  now: number;
  onDraftChange: (value: string) => void;
  onSave: () => void;
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
          <label htmlFor="gallery-audio-note" className="font-serif text-xs italic text-muted-foreground">
            your note
          </label>
          <Textarea
            id="gallery-audio-note"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="write a line about this one…"
            spellCheck
            className="min-h-24 resize-y rounded-md bg-background text-[0.95rem] leading-relaxed text-foreground"
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/70 px-6 py-3">
          <span className="min-w-0 truncate font-serif text-xs italic text-muted-foreground">
            {dirty ? "unsaved" : noteSaved ? "note kept" : ""}
          </span>
          <div className="flex items-center gap-1">
            <Button asChild type="button" variant="ghost" size="icon-sm" title="open original" aria-label="open original">
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
              </a>
            </Button>
            <Button type="button" size="sm" onClick={onSave} disabled={!dirty || savingNote}>
              <Save className="size-3.5" />
              {savingNote ? "saving" : "save note"}
            </Button>
          </div>
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

function Lightbox({
  item,
  index,
  total,
  draft,
  dirty,
  savingNote,
  noteSaved,
  now,
  onDraftChange,
  onSave,
  onNavigate,
}: {
  item: GalleryItem;
  index: number;
  total: number;
  draft: string;
  dirty: boolean;
  savingNote: boolean;
  noteSaved: boolean;
  now: number;
  onDraftChange: (value: string) => void;
  onSave: () => void;
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
              <label htmlFor="gallery-note" className="font-serif text-xs italic text-muted-foreground">
                your note
              </label>
              <Textarea
                id="gallery-note"
                value={draft}
                onChange={(event) => onDraftChange(event.target.value)}
                placeholder="write a line about this one…"
                spellCheck
                className="min-h-32 resize-y rounded-md bg-background text-[0.95rem] leading-relaxed text-foreground"
              />
            </div>
          </ScrollArea>

          <div className="flex items-center justify-between gap-2 border-t border-border/70 px-5 py-3">
            <span className="min-w-0 truncate font-serif text-xs italic text-muted-foreground">
              {dirty ? "unsaved" : noteSaved ? "note kept" : ""}
            </span>
            <div className="flex items-center gap-1">
              <Button asChild type="button" variant="ghost" size="icon-sm" title="open original" aria-label="open original">
                <a href={item.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-4" />
                </a>
              </Button>
              <Button type="button" size="sm" onClick={onSave} disabled={!dirty || savingNote}>
                <Save className="size-3.5" />
                {savingNote ? "saving" : "save note"}
              </Button>
            </div>
          </div>
        </aside>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function GalleryPage({ nav }: { nav?: ReactNode }) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [openIndex, setOpenIndex] = useState<number>();
  const [draft, setDraft] = useState("");
  const [trackedId, setTrackedId] = useState<string>();
  const [savingNote, setSavingNote] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const [now] = useState(() => Date.now());

  const openItem = openIndex !== undefined ? items[openIndex] : undefined;
  const dirty = openItem ? draft !== openItem.note : false;

  // Reset the draft when a different piece opens (or it closes). Note saves only
  // change the item's `note`, not its id, so an in-progress draft survives them.
  if (openItem?.id !== trackedId) {
    setTrackedId(openItem?.id);
    setDraft(openItem?.note ?? "");
    setNoteSaved(false);
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchGallery();
      next.sort((a, b) => b.createdAt - a.createdAt);
      setItems(next);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const persistNote = useCallback(async (id: string, text: string) => {
    setSavingNote(true);
    setError(undefined);
    try {
      const saved = await saveGalleryNote(id, text);
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, note: saved } : it)));
      setNoteSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingNote(false);
    }
  }, []);

  const flushIfDirty = useCallback(async () => {
    if (openItem && draft !== openItem.note) await persistNote(openItem.id, draft);
  }, [draft, openItem, persistNote]);

  const navigate = useCallback(
    async (delta: number) => {
      if (openIndex === undefined) return;
      const target = openIndex + delta;
      if (target < 0 || target >= items.length) return;
      await flushIfDirty();
      setOpenIndex(target);
    },
    [flushIfDirty, items.length, openIndex],
  );

  const close = useCallback(() => {
    void flushIfDirty();
    setOpenIndex(undefined);
  }, [flushIfDirty]);

  useEffect(() => {
    if (openIndex === undefined) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      event.preventDefault();
      void navigate(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, openIndex]);

  const groups = useMemo(() => groupByTime(items, now), [items, now]);
  const showSkeleton = loading && !loaded;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="border-b-2 border-primary/20 bg-background px-3 py-4 md:px-8">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          {nav}
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h1 className="font-serif text-2xl leading-none tracking-tight">makings</h1>
            <p className="font-serif text-[0.8rem] italic text-muted-foreground">the images and sounds it made</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="refresh"
            title="refresh"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin motion-reduce:animate-none")} />
          </Button>
        </div>
      </header>

      {error ? (
        <p className="border-b border-border bg-card px-3 py-2 font-serif text-xs italic text-destructive md:px-8">
          {error}
        </p>
      ) : null}

      {showSkeleton ? (
        <GallerySkeleton />
      ) : items.length === 0 ? (
        <EmptyGallery onRefresh={() => void load()} />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <GalleryGrid groups={groups} onOpen={setOpenIndex} />
        </ScrollArea>
      )}

      <DialogPrimitive.Root open={openItem !== undefined} onOpenChange={(open) => (open ? undefined : close())}>
        {openItem ? (
          openItem.kind === "audio" ? (
            <AudioNotePopup
              item={openItem}
              index={openIndex ?? 0}
              total={items.length}
              draft={draft}
              dirty={dirty}
              savingNote={savingNote}
              noteSaved={noteSaved}
              now={now}
              onDraftChange={(value) => {
                setDraft(value);
                setNoteSaved(false);
              }}
              onSave={() => {
                if (openItem) void persistNote(openItem.id, draft);
              }}
            />
          ) : (
            <Lightbox
              item={openItem}
              index={openIndex ?? 0}
              total={items.length}
              draft={draft}
              dirty={dirty}
              savingNote={savingNote}
              noteSaved={noteSaved}
              now={now}
              onDraftChange={(value) => {
                setDraft(value);
                setNoteSaved(false);
              }}
              onSave={() => {
                if (openItem) void persistNote(openItem.id, draft);
              }}
              onNavigate={(delta) => void navigate(delta)}
            />
          )
        ) : null}
      </DialogPrimitive.Root>
    </div>
  );
}
