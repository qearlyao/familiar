import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BookPlus } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { deleteBook, fetchBooks, uploadBook, type BookSummary } from "@/lib/api";
import { BookCover } from "./library/BookCover";
import { ReaderView } from "./reader/ReaderView";

const ACCEPTED = ".epub,.txt,.md";

function progressPhrase(percent: number): string {
  if (percent < 4) return "just begun";
  if (percent < 30) return "early pages";
  if (percent < 62) return "midway through";
  if (percent < 92) return "deep in it";
  return "nearly done";
}

/**
 * Right-click (or long-press) any book to let it go — nothing on the tile
 * itself, and a proper confirmation before it leaves.
 */
function ShelfBook({
  book,
  onRemove,
  children,
}: {
  book: BookSummary;
  onRemove: () => void;
  children: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            remove from shelf
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif font-normal">let "{book.title}" go?</AlertDialogTitle>
            <AlertDialogDescription className="font-serif italic">
              it leaves the shelf, and the margins go with it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onRemove}>
              let it go
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function BookTile({
  book,
  onOpen,
  onRemove,
}: {
  book: BookSummary;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <ShelfBook book={book} onRemove={onRemove}>
      <div className="group flex flex-col gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="rounded-sm text-left focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <BookCover
            book={book}
            className="transition-shadow duration-300 ease-out group-hover:shadow-lg motion-reduce:transition-none"
          />
        </button>
        <div className="min-w-0 px-0.5">
          <p className="truncate text-[13px] leading-tight">{book.title}</p>
          {book.author ? (
            <p className="truncate font-serif text-[11px] italic text-muted-foreground">{book.author}</p>
          ) : null}
          {book.percent != null && book.percent > 0 ? (
            <p className="font-serif text-[11px] italic text-muted-foreground/80">{Math.round(book.percent)}%</p>
          ) : null}
        </div>
      </div>
    </ShelfBook>
  );
}

export function LibraryPage({ nav }: { nav?: ReactNode }) {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [openBookId, setOpenBookId] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  const reload = useCallback(async () => {
    try {
      setBooks(await fetchBooks());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(id);
  }, [reload]);

  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      const accepted = Array.from(files).filter((f) => /\.(epub|txt|md)$/i.test(f.name));
      if (accepted.length === 0) return;
      setUploading(true);
      try {
        for (const file of accepted) {
          const book = await uploadBook(file);
          setBooks((prev) => [book, ...prev.filter((b) => b.id !== book.id)]);
        }
        setError(undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    try {
      await deleteBook(id);
      setBooks((prev) => prev.filter((b) => b.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const current = books.find((b) => b.position);
  const rest = books.filter((b) => b !== current);
  const openBook = books.find((b) => b.id === openBookId);

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-background text-foreground"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepthRef.current += 1;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        dragDepthRef.current = 0;
        setDragging(false);
        void importFiles(e.dataTransfer.files);
      }}
    >
      <header className="border-b-2 border-primary/20 bg-background px-3 py-4 md:px-8">
        <div className="mx-auto flex max-w-6xl items-center gap-3 low-dpr-wide:max-w-[clamp(72rem,62vw,88rem)]">
          {nav}
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h1 className="font-serif text-2xl leading-none tracking-tight">library</h1>
            <p className="font-serif text-[0.8rem] italic text-muted-foreground">the shelf you share</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={uploading ? "bringing it in" : "add a book"}
            title={uploading ? "bringing it in" : "add a book"}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="size-11 text-muted-foreground hover:text-foreground"
          >
            <BookPlus
              className={uploading ? "size-5 animate-pulse motion-reduce:animate-none" : "size-5"}
            />
          </Button>
        </div>
      </header>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED}
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void importFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {error ? (
        <p className="px-3 py-2 text-center font-serif text-xs italic text-destructive md:px-8">
          couldn't tend the shelf · {error}
        </p>
      ) : null}

      {loaded && books.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
          <p className="max-w-sm text-center font-serif text-base italic leading-relaxed text-muted-foreground">
            the shelf is bare. drop an epub anywhere — we'll read it together.
          </p>
          <Button type="button" onClick={() => fileInputRef.current?.click()}>
            choose a book
          </Button>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto max-w-6xl px-4 pt-6 pb-12 md:px-8 low-dpr-wide:max-w-[clamp(72rem,62vw,88rem)]">
            {current ? (
              <section className="mt-10 flex items-center gap-6 md:gap-10">
                <ShelfBook book={current} onRemove={() => void remove(current.id)}>
                  <button
                    type="button"
                    onClick={() => setOpenBookId(current.id)}
                    className="group w-32 shrink-0 rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:w-44"
                  >
                    <BookCover
                      book={current}
                      className="shadow-lg transition-shadow duration-300 ease-out group-hover:shadow-xl motion-reduce:transition-none"
                    />
                  </button>
                </ShelfBook>
                <div className="min-w-0">
                  <p className="font-serif text-xs italic text-muted-foreground">reading now</p>
                  <h2 className="mt-1.5 font-serif text-2xl leading-tight tracking-tight md:text-3xl">
                    {current.title}
                  </h2>
                  {current.author ? (
                    <p className="mt-1 font-serif text-base italic text-muted-foreground">{current.author}</p>
                  ) : null}
                  {current.percent != null ? (
                    <p className="mt-4 font-serif text-xs italic text-muted-foreground">
                      {progressPhrase(current.percent)} · {Math.round(current.percent)}%
                    </p>
                  ) : null}
                  <Button type="button" className="mt-5" onClick={() => setOpenBookId(current.id)}>
                    keep reading
                  </Button>
                </div>
              </section>
            ) : null}

            {rest.length > 0 ? (
              <div className="mt-12 grid grid-cols-3 gap-x-5 gap-y-8 sm:grid-cols-4 md:grid-cols-5">
                {rest.map((book) => (
                  <BookTile
                    key={book.id}
                    book={book}
                    onOpen={() => setOpenBookId(book.id)}
                    onRemove={() => void remove(book.id)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </ScrollArea>
      )}

      {dragging ? (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/85"
          style={{
            backgroundImage:
              "radial-gradient(closest-side at 50% 50%, color-mix(in oklch, var(--primary) 14%, transparent), transparent)",
          }}
        >
          <p className="font-serif text-lg italic text-muted-foreground">let it fall here</p>
        </div>
      ) : null}

      {openBook ? (
        <ReaderView
          book={openBook}
          onClose={() => {
            setOpenBookId(undefined);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}
