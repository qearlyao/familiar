import { useState } from "react";
import type { MarginScale, MarginaliaEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import { entryKind, initial, type EntryKind } from "./marginText";
import { isWaiting } from "./useMarginalia";

const ON_SCALE: Record<MarginScale, string> = {
  word: "on your selection",
  paragraph: "on this paragraph",
  page: "on this page",
};

function Thread({
  entry,
  personaName,
  onReply,
}: {
  entry: MarginaliaEntry;
  personaName: string;
  onReply: (entryId: string, text: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<string>();
  const last = entry.thread.at(-1);
  const waiting = isWaiting(entry);

  const send = async () => {
    const text = draft?.trim();
    if (!text) return;
    setDraft(undefined);
    await onReply(entry.id, text);
  };

  return (
    <div className="reader-margin-item is-fern">
      <span className="reader-margin-voice">
        <i>{initial(personaName)}</i>
        {personaName} · {ON_SCALE[entry.scale]}
      </span>
      {entry.scale !== "page" ? <q>{entry.quote.trim()}</q> : null}
      {entry.note ? <p className="is-you">{entry.note}</p> : null}
      {entry.thread.map((message) =>
        message.text ? (
          <p key={message.id} className={cn(message.author === "you" && "is-you")}>{message.text}</p>
        ) : null,
      )}
      {waiting ? <p className="reader-margin-status">{personaName} is reading it…</p> : null}
      {last?.reply === "quiet" ? <p className="reader-margin-status">{personaName} let this one sit.</p> : null}
      {last?.reply === "failed" ? <p className="reader-margin-status is-error">the reply didn't come · {last.error}</p> : null}
      {draft === undefined ? (
        !waiting ? (
          <div className="reader-margin-actions">
            <button type="button" onClick={() => setDraft("")}>reply</button>
          </div>
        ) : null
      ) : (
        <form
          className="reader-margin-reply"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            autoFocus
            rows={2}
            value={draft}
            placeholder="write back in the margin…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                setDraft(undefined);
              }
            }}
          />
          <div className="reader-margin-actions">
            <button type="submit" className="is-send" disabled={!draft.trim()}>send</button>
            <button type="button" onClick={() => setDraft(undefined)}>not now</button>
          </div>
        </form>
      )}
    </div>
  );
}

const EARLIER: { kind: EntryKind; label: string }[] = [
  { kind: "note", label: "your notes" },
  { kind: "thread", label: "threads" },
  { kind: "highlight", label: "highlights" },
];

/**
 * The gutter beside the page: your notes and her threads for what's on screen,
 * in the order they were made, and a tally of what's further back.
 */
export function ReaderMargin({
  entries,
  visible,
  personaName,
  onSeek,
  onReply,
}: {
  /** The current chapter's entries. */
  entries: MarginaliaEntry[];
  /** Chapter text offsets on screen. */
  visible?: { start: number; end: number };
  personaName: string;
  onSeek: (entry: MarginaliaEntry) => void;
  onReply: (entryId: string, text: string) => Promise<unknown>;
}) {
  const here = visible
    ? entries
        .filter((entry) => entry.offset >= visible.start && entry.offset < visible.end && entryKind(entry) !== "highlight")
        .sort((a, b) => a.createdAt - b.createdAt)
    : [];
  const earlier = visible ? entries.filter((entry) => entry.offset < visible.start) : [];

  return (
    <aside className="reader-page-margin" aria-label="notes on this page">
      <h2>this page</h2>
      {here.length === 0 ? <p className="reader-margin-empty">nothing in the margin here yet.</p> : null}
      {here.map((entry) =>
        entryKind(entry) === "thread" ? (
          <Thread key={entry.id} entry={entry} personaName={personaName} onReply={onReply} />
        ) : (
          <div key={entry.id} className="reader-margin-item is-yours">
            <span>your note · p. {entry.page}</span>
            <p>{entry.note}</p>
          </div>
        ),
      )}
      {earlier.length > 0 ? (
        <div className="reader-margin-earlier">
          <h2>earlier in this chapter</h2>
          <div>
            {EARLIER.map(({ kind, label }) => {
              const ofKind = earlier.filter((entry) => entryKind(entry) === kind);
              if (ofKind.length === 0) return null;
              const nearest = ofKind.reduce((a, b) => (b.offset > a.offset ? b : a));
              return (
                <button key={kind} type="button" className={`is-${kind}`} title={`${label} · go to the nearest`} onClick={() => onSeek(nearest)}>
                  {ofKind.length}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
