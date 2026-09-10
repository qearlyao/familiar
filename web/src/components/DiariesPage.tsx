import { useEffect, useState } from "react";
import { DiaryCalendar } from "@/components/diaries/DiaryCalendar";
import { MarkdownView } from "@/components/diaries/MarkdownView";
import { fetchDiaries, fetchDiary, type DiaryEntry, type DiarySummary } from "@/lib/api";
import { dayStamp, diaryNote, formatDiaryDate } from "@/lib/diaries/format";
import { cn } from "@/lib/utils";
import { IconChevronLeft, IconExpand, IconSearch, IconX } from "./organicIcons";
import "./diaries/diaries.css";

/** Diaries 1a/1b: the archive. A month at a glance on the left, tinted by how much was written;
    the day you pick opens on the right. Search takes a date or a phrase — the written days are
    all here already, so it reads them where they sit.

    A phone gets it as a pushed page (1b): no room bar at the bottom, a back arrow to the talk,
    search behind its icon, and the day can take the whole screen when you want to read it. */

const words = (content: string) => content.trim().split(/\s+/).filter(Boolean).length;

export function DiariesPage({ onBring, onBack }: { onBring: (text: string) => void; onBack: () => void }) {
  const [diaries, setDiaries] = useState<DiarySummary[]>([]);
  const [date, setDate] = useState<string | undefined>();
  const [month, setMonth] = useState<string | undefined>();
  const [entry, setEntry] = useState<DiaryEntry | undefined>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  // phone only: the search field folds behind its icon, and the day can take the whole screen
  const [searching, setSearching] = useState(false);
  const [full, setFull] = useState(false);

  useEffect(() => {
    let live = true;
    fetchDiaries()
      .then((all) => {
        if (!live) return;
        setDiaries(all);
        setDate(all[0]?.date);
        setMonth(all[0]?.date.slice(0, 7));
      })
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!date) return;
    let live = true;
    fetchDiary(date)
      .then((read) => live && setEntry(read))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [date]);

  const counts = new Map<string, number>();
  const weights = new Map<string, number>();
  for (const diary of diaries) {
    const key = diary.date.slice(0, 7);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    weights.set(diary.date, diary.sizeBytes);
  }

  const look = query.trim().toLowerCase();
  // one haystack: the day as it is spoken, its title, and the lines under it
  const found = look
    ? diaries.filter((d) => `${formatDiaryDate(d.date)} ${d.date} ${d.title} ${d.excerpt}`.toLowerCase().includes(look))
    : undefined;

  const pick = (next: string) => {
    setDate(next);
    setMonth(next.slice(0, 7));
  };

  const at = diaries.findIndex((d) => d.date === date);
  const older = at >= 0 ? diaries[at + 1] : undefined;
  const newer = at > 0 ? diaries[at - 1] : undefined;
  const open = entry?.date === date ? entry : undefined;

  return (
    <div className={cn("diaries-room chat-theme", searching && "is-searching", full && "is-full")}>
      <header className="diaries-bar">
        <button type="button" aria-label="back to the talk" title="back to the talk" onClick={onBack}>
          <IconChevronLeft size={17} />
        </button>
        <b>diaries</b>
        <button
          type="button"
          className="diaries-find"
          aria-label="search the diaries"
          aria-pressed={searching}
          onClick={() => setSearching((on) => !on)}
        >
          <IconSearch size={17} />
        </button>
      </header>
      <aside className="diaries-side">
        <label className="diaries-search">
          <IconSearch size={15} />
          <input
            type="search"
            value={query}
            placeholder="a date, or something you wrote"
            aria-label="search the diaries"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" aria-label="clear the search" onClick={() => setQuery("")}><IconX size={13} /></button>
          )}
        </label>

        {found ? (
          <div className="diaries-found">
            {found.length === 0 && <p className="diaries-note">no day reads like that.</p>}
            {found.map((diary) => (
              <button
                key={diary.date}
                type="button"
                className={cn("diaries-hit", diary.date === date && "is-on")}
                onClick={() => pick(diary.date)}
              >
                <em>{dayStamp(diary.date)}</em>
                <b>{diary.title}</b>
              </button>
            ))}
          </div>
        ) : month ? (
          <>
            <DiaryCalendar month={month} onMonth={setMonth} counts={counts} weights={weights} selected={date} onSelect={pick} />
            <div className="diaries-legend">
              <span data-weight="1">a few lines</span>
              <span data-weight="2">a page</span>
              <span data-weight="3">a long one</span>
            </div>
          </>
        ) : null}
      </aside>

      <article className="diaries-open">
        {error && <p className="diaries-note" role="alert">the archive wouldn’t open · {error}</p>}
        {!open ? (
          <p className="diaries-note">{loading ? "…" : diaries.length === 0 ? "no days written yet." : "choose a written day."}</p>
        ) : (
          <>
            <header className="diaries-head">
              <div className="diaries-title">
                <span>{formatDiaryDate(open.date)}</span>
                <b>{open.title}</b>
              </div>
              {/* beside the title on a desk; on a phone the head lets go (display: contents) and this drops to the foot */}
              <div className="diaries-do">
                <button
                  type="button"
                  className="diaries-bring"
                  onClick={() => onBring(diaryNote([{ date: open.date, title: open.title }]))}
                >
                  bring into the talk
                </button>
                <button
                  type="button"
                  className="diaries-expand"
                  aria-label={full ? "show the month again" : "read it all"}
                  title={full ? "show the month again" : "read it all"}
                  aria-pressed={full}
                  onClick={() => setFull((on) => !on)}
                >
                  <IconExpand size={17} />
                </button>
              </div>
            </header>
            <div className="diaries-chips">
              <span>{words(open.content).toLocaleString()} words</span>
            </div>
            <div className="diaries-body">
              <MarkdownView content={open.content} title={open.title} />
            </div>
            <footer className="diaries-turn">
              {older && (
                <button type="button" onClick={() => pick(older.date)}>← {dayStamp(older.date)}, {older.title}</button>
              )}
              {newer && (
                <button type="button" className="is-next" onClick={() => pick(newer.date)}>{dayStamp(newer.date)}, {newer.title} →</button>
              )}
            </footer>
          </>
        )}
      </article>
    </div>
  );
}
