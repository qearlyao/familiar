import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, MessageSquareText, Plus, Search } from "lucide-react";
import {
  deleteBook,
  deleteKeptFile,
  fetchBooks,
  fetchKeptFiles,
  fetchMarginalia,
  uploadBook,
  type BookSummary,
  type KeptFile,
  type MarginaliaEntry,
} from "@/lib/api";
import { BookCover } from "./library/BookCover";
import { KeptFileTile } from "./library/KeptFiles";
import { ShelfItem } from "./library/ShelfItem";
import { noteAge } from "./reader/marginText";
import { ReaderView } from "./reader/ReaderView";
import "./library.css";

const ACCEPTED = ".epub,.txt,.md";
const FILTERS = ["everything", "books", "papers", "annotated", "theirs"] as const;
type LibraryFilter = (typeof FILTERS)[number];

function shelfLine(book: BookSummary, notes: MarginaliaEntry[]): string {
  if (book.position) {
    const progress = book.percent != null ? `${Math.max(1, Math.round(book.percent))}% read` : `chapter ${book.position.chapter + 1}`;
    return notes.length > 0 ? `${progress} · ${notes.length} ${notes.length === 1 ? "note" : "notes"}` : progress;
  }
  if (notes.length > 0) return `${notes.length} ${notes.length === 1 ? "note" : "notes"}`;
  return `added ${noteAge(book.createdAt)}`;
}

function matchesFilter(book: BookSummary, notes: MarginaliaEntry[], filter: LibraryFilter): boolean {
  if (filter === "everything") return true;
  if (filter === "theirs") return false;
  if (filter === "books") return book.format === "epub";
  if (filter === "papers") return book.format === "text";
  return notes.length > 0;
}

const BOOK_FAREWELL = "it leaves the shelf, and the margins go with it.";

function OpenBookCard({
  book,
  notes,
  onOpen,
  onRemove,
}: {
  book: BookSummary;
  notes: MarginaliaEntry[];
  onOpen: () => void;
  onRemove: () => void;
}) {
  const percent = Math.max(1, Math.round(book.percent ?? 0));
  return (
    <ShelfItem title={book.title} farewell={BOOK_FAREWELL} onRemove={onRemove}>
      <button type="button" className="library-open-card" onClick={onOpen}>
        <BookCover book={book} className="library-open-cover" />
        <span className="library-open-copy">
          <strong>{book.title}</strong>
          <span>
            {book.author ? `${book.author} · ` : ""}chapter {(book.position?.chapter ?? 0) + 1} of {book.chapterCount}
          </span>
          <span className="library-progress" aria-label={`${percent}% read`}>
            <i style={{ width: `${percent}%` }} />
          </span>
          <span>{percent}% read</span>
          <span className="library-margin-count">
            {notes.length > 0 ? (
              <>
                <MessageSquareText aria-hidden="true" />
                {notes.length} {notes.length === 1 ? "note" : "notes"} in the margin
              </>
            ) : (
              "the margin is waiting"
            )}
          </span>
          <span className="library-keep-reading">keep reading</span>
        </span>
      </button>
    </ShelfItem>
  );
}

function ShelfTile({
  book,
  notes,
  onOpen,
  onRemove,
}: {
  book: BookSummary;
  notes: MarginaliaEntry[];
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <ShelfItem title={book.title} farewell={BOOK_FAREWELL} onRemove={onRemove}>
      <button type="button" className="library-shelf-tile" onClick={onOpen}>
        <BookCover book={book} className="library-shelf-cover" />
        <span className="library-shelf-copy">
          <strong>{book.title}</strong>
          <span>
            <span className="library-shelf-kind">{book.format === "epub" ? "book" : "paper"} · </span>
            {shelfLine(book, notes)}
          </span>
        </span>
      </button>
    </ShelfItem>
  );
}

export function LibraryPage({ personaName }: { personaName: string }) {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [kept, setKept] = useState<KeptFile[]>([]);
  const [notesByBook, setNotesByBook] = useState<Record<string, MarginaliaEntry[]>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [openBookId, setOpenBookId] = useState<string>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("everything");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  const reload = useCallback(async () => {
    try {
      const [nextBooks, nextKept] = await Promise.all([fetchBooks(), fetchKeptFiles()]);
      const notes = await Promise.all(nextBooks.map(async (book) => [book.id, await fetchMarginalia(book.id)] as const));
      setBooks(nextBooks);
      setKept(nextKept);
      setNotesByBook(Object.fromEntries(notes));
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

  const importFiles = useCallback(async (files: FileList | File[]) => {
    const accepted = Array.from(files).filter((file) => /\.(epub|txt|md)$/i.test(file.name));
    if (accepted.length === 0) {
      setError("only epub, txt, and markdown files can join the shelf");
      return;
    }
    setUploading(true);
    try {
      for (const file of accepted) await uploadBook(file);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, [reload]);

  const remove = useCallback(async (removeOne: () => Promise<void>) => {
    try {
      await removeOne();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [reload]);

  const matching = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return books.filter((book) => {
      const notes = notesByBook[book.id] ?? [];
      if (!matchesFilter(book, notes, filter)) return false;
      if (!needle) return true;
      const haystack = [book.title, book.author ?? "", ...notes.flatMap((entry) => [entry.quote, entry.note ?? ""])]
        .join("\n")
        .toLocaleLowerCase();
      return haystack.includes(needle);
    });
  }, [books, filter, notesByBook, query]);

  const matchingKept = useMemo(() => {
    if (filter !== "everything" && filter !== "theirs") return [];
    const needle = query.trim().toLocaleLowerCase();
    return kept.filter((file) => !needle || `${file.name}\n${file.source}`.toLocaleLowerCase().includes(needle));
  }, [filter, kept, query]);

  const openBooks = matching.filter((book) => book.position);
  const shelfBooks = matching.filter((book) => !book.position);
  const mobileShelfBooks = matching.filter((book, index) => !book.position || index > 0);
  const openBook = books.find((book) => book.id === openBookId);
  const tile = (book: BookSummary) => (
    <ShelfTile
      key={book.id}
      book={book}
      notes={notesByBook[book.id] ?? []}
      onOpen={() => setOpenBookId(book.id)}
      onRemove={() => void remove(() => deleteBook(book.id))}
    />
  );

  return (
    <div
      className="library-room relative flex h-full min-h-0 flex-col"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        dragDepthRef.current += 1;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragging(false);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragging(false);
        void importFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED}
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files) void importFiles(event.target.files);
          event.target.value = "";
        }}
      />

      <header className="library-header">
        <div className="library-title-block">
          <span>{books.length + kept.length} {books.length + kept.length === 1 ? "thing" : "things"}, {books.filter((book) => book.position).length} open</span>
          <h1>the library</h1>
        </div>
        <div className="library-actions">
          <label className="library-search">
            <Search aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="search titles and notes" />
          </label>
          <button
            type="button"
            className="library-add"
            aria-label={uploading ? "bringing it in" : "add to the library"}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <Plus aria-hidden="true" />
            <span>{uploading ? "adding…" : "add"}</span>
          </button>
        </div>
      </header>

      <div className="library-filters" role="group" aria-label="filter the library">
        {FILTERS.map((item) => (
          <button key={item} type="button" aria-pressed={filter === item} onClick={() => setFilter(item)}>
            {item === "theirs" ? `from ${personaName}` : item}
          </button>
        ))}
      </div>

      {error ? <p className="library-error">couldn't tend the shelf · {error}</p> : null}

      <div className="library-scroll">
        {!loaded ? (
          <p className="library-empty">opening the library…</p>
        ) : books.length === 0 && kept.length === 0 ? (
          <div className="library-empty">
            <p>the shelf is bare. bring an epub, text, or markdown file and we’ll read it together.</p>
            <button type="button" onClick={() => fileInputRef.current?.click()}>choose a book</button>
          </div>
        ) : matching.length === 0 && matchingKept.length === 0 ? (
          <p className="library-empty">nothing on the shelf matches that.</p>
        ) : (
          <>
            {openBooks.length > 0 ? (
              <section className="library-open-section">
                <h2>still open</h2>
                <div className="library-open-grid">
                  {openBooks.map((book) => (
                    <OpenBookCard
                      key={book.id}
                      book={book}
                      notes={notesByBook[book.id] ?? []}
                      onOpen={() => setOpenBookId(book.id)}
                      onRemove={() => void remove(() => deleteBook(book.id))}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {matchingKept.length > 0 ? (
              <section className="library-shelf-section library-kept-section">
                <h2>from {personaName}</h2>
                <div className="library-shelf-grid library-kept-grid">
                  {matchingKept.map((file) => (
                    <KeptFileTile key={file.id} file={file} onRemove={() => void remove(() => deleteKeptFile(file.id))} />
                  ))}
                </div>
              </section>
            ) : null}

            {filter === "theirs" ? null : <section className="library-shelf-section">
              <h2>on the shelf</h2>
              <div className="library-shelf-grid library-shelf-desktop">
                {shelfBooks.map(tile)}
                <button type="button" className="library-drop-tile" onClick={() => fileInputRef.current?.click()}>
                  <span><Plus aria-hidden="true" />drop a file</span>
                  <small>epub, text, or markdown</small>
                </button>
              </div>
              <div className="library-shelf-list library-shelf-mobile">
                {mobileShelfBooks.map(tile)}
              </div>
            </section>}
          </>
        )}
      </div>

      {dragging ? (
        <div className="library-drag-overlay">
          <FileText aria-hidden="true" />
          <p>let it fall here</p>
          <span>epub, text, or markdown</span>
        </div>
      ) : null}

      {openBook ? (
        <ReaderView
          personaName={personaName}
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
