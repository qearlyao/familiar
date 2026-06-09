import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Lightbox } from "./gallery/GalleryDialogs";
import { EmptyGallery, GalleryGrid, GallerySkeleton } from "./gallery/GalleryTiles";
import { groupByTime } from "./gallery/format";
import { useGalleryItems } from "./gallery/useGalleryItems";
import { useGalleryNoteDraft } from "./gallery/useGalleryNoteDraft";

export function GalleryPage({ nav }: { nav?: ReactNode }) {
  const { items, loading, loaded, error: loadError, reload, updateNote } = useGalleryItems();
  const [openIndex, setOpenIndex] = useState<number>();
  const [now] = useState(() => Date.now());

  const openItem = openIndex !== undefined ? items[openIndex] : undefined;
  const note = useGalleryNoteDraft({ item: openItem, saveNote: updateNote });
  const groups = useMemo(() => groupByTime(items, now), [items, now]);
  const showSkeleton = loading && !loaded;
  const error = loadError ?? note.noteError;

  const navigate = useCallback(
    async (delta: number) => {
      if (openIndex === undefined) return;
      const target = openIndex + delta;
      if (target < 0 || target >= items.length) return;
      if (!(await note.flushIfDirty())) return;
      setOpenIndex(target);
    },
    [items.length, note, openIndex],
  );

  const close = useCallback(async () => {
    if (!(await note.flushIfDirty())) return;
    setOpenIndex(undefined);
  }, [note]);

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

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="border-b-2 border-primary/20 bg-background px-3 py-4 md:px-8">
        <div className="workspace-frame flex items-center gap-3">
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
            onClick={() => void reload()}
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
        <EmptyGallery onRefresh={() => void reload()} />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <GalleryGrid groups={groups} onOpen={setOpenIndex} />
        </ScrollArea>
      )}

      <DialogPrimitive.Root
        open={openItem !== undefined}
        onOpenChange={(open) => {
          if (!open) void close();
        }}
      >
        {openItem ? (
          <Lightbox
            item={openItem}
            index={openIndex ?? 0}
            total={items.length}
            note={{
              text: openItem.note,
              savingNote: note.savingNote,
              noteSaved: note.noteSaved,
              noteError: note.noteError,
              onSave: note.saveCurrentNote,
            }}
            now={now}
            onNavigate={(delta) => void navigate(delta)}
          />
        ) : null}
      </DialogPrimitive.Root>
    </div>
  );
}
