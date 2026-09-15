import { Fragment, useMemo, useState } from "react";
import type { BookChapterInfo, BookSummary, MarginaliaEntry } from "@/lib/api";
import { CloseIcon, ExportIcon } from "./readerIcons";
import { chapterLabel, companionReplies, entryKind, initial, noteAge, noteTally } from "./marginText";

type NotesFilter = "all" | "yours" | "hers" | "highlights";

function matches(entry: MarginaliaEntry, filter: NotesFilter): boolean {
  if (filter === "all") return true;
  if (filter === "yours") return !!entry.note;
  if (filter === "hers") return companionReplies(entry).length > 0;
  return entryKind(entry) === "highlight";
}

/** Every note in the book, over the page: latest in the book first, grouped by chapter. */
export function BookNotesDrawer({
  book,
  chapters,
  entries,
  personaName,
  compact,
  onClose,
  onEntry,
}: {
  book: BookSummary;
  chapters: BookChapterInfo[];
  entries: MarginaliaEntry[];
  personaName: string;
  compact: boolean;
  onClose: () => void;
  onEntry: (entry: MarginaliaEntry) => void;
}) {
  const [filter, setFilter] = useState<NotesFilter>("all");
  const tally = noteTally(entries);
  const items = useMemo(
    () =>
      entries
        .filter((entry) => matches(entry, filter))
        .sort((a, b) => b.chapter - a.chapter || b.offset - a.offset),
    [entries, filter],
  );

  const exportNotes = () => {
    const body = items
      .map((entry) => {
        const where = `${chapterLabel(entry.chapter, chapters)}, p. ${entry.page}`;
        const lines = [`${where}`, `“${entry.quote.trim()}”`];
        if (entry.note) lines.push(`Your note: ${entry.note}`);
        for (const message of entry.thread) {
          if (message.text) lines.push(`${message.author === "you" ? "You" : personaName}: ${message.text}`);
        }
        return lines.join("\n");
      })
      .join("\n\n—\n\n");
    const url = URL.createObjectURL(new Blob([`${book.title}\n\n${body || "No notes yet."}\n`], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${book.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}-notes.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const filters: { id: NotesFilter; label: string }[] = [
    { id: "all", label: `all ${tally.total}` },
    { id: "yours", label: `yours · ${tally.yours}` },
    { id: "hers", label: `${personaName} · ${tally.hers}` },
    { id: "highlights", label: compact ? "highlights" : "highlights only" },
  ];

  return (
    <div className="book-notes-layer" role="dialog" aria-modal="true" aria-label={`every note in ${book.title}`}>
      <button type="button" className="book-notes-dim" aria-label="back to the page" onClick={onClose} />
      <section className="book-notes-drawer">
        <header>
          <div>
            <span>{compact ? book.title : `${book.title} · ${book.chapterCount} chapters`}</span>
            <h2>{tally.total} {tally.total === 1 ? "note" : "notes"}</h2>
          </div>
          <button type="button" className="book-notes-close" aria-label="back to the page" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <nav aria-label="filter notes">
          {filters.map((item) => (
            <button key={item.id} type="button" className={`is-${item.id}`} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="book-notes-list">
          {items.length === 0 ? <p className="book-notes-empty">nothing in this part of the margins yet.</p> : null}
          {items.map((entry, index) => {
            const kind = entryKind(entry);
            const reply = companionReplies(entry).at(-1);
            const age = compact ? "" : ` · ${noteAge(reply?.createdAt ?? entry.updatedAt)}`;
            const newChapter = index === 0 || items[index - 1]!.chapter !== entry.chapter;
            return (
              <Fragment key={entry.id}>
                {newChapter ? <h3>{chapterLabel(entry.chapter, chapters)}</h3> : null}
                <button type="button" className={`book-note-row is-${kind}`} onClick={() => onEntry(entry)}>
                  <i aria-hidden="true" />
                  <span>
                    {kind === "thread" ? (
                      <small className="is-voice"><b>{initial(personaName)}</b>p. {entry.page}{age}</small>
                    ) : (
                      <small>p. {entry.page} · {kind === "note" ? "your note" : "highlight, no note"}{age}</small>
                    )}
                    {kind === "highlight" ? (
                      <p>{entry.quote.trim()}</p>
                    ) : (
                      <>
                        {entry.scale !== "page" ? <q>{entry.quote.trim()}</q> : null}
                        <p>{kind === "thread" ? reply?.text ?? entry.thread.at(-1)?.text : entry.note}</p>
                      </>
                    )}
                  </span>
                </button>
              </Fragment>
            );
          })}
        </div>

        <footer>
          <button type="button" onClick={exportNotes}><ExportIcon />export</button>
          <span>{tally.yours} yours · {tally.hers} from {personaName}</span>
        </footer>
      </section>
    </div>
  );
}
