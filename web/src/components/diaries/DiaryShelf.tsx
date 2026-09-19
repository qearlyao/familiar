import { useState } from "react";
import { useDiaries } from "@/lib/diaries/useDiaries";
import { dayStamp, diaryNote } from "@/lib/diaries/format";
import { cn } from "@/lib/utils";
import { Shelf } from "../Shelf";
import { IconCheck } from "../organicIcons";

/** Diaries 1c + Chat 1a: the last seven days, held open over the talk. Ticking days
    drops a note in the draft naming them — the agent decides whether to recall them
    or open the pages in full. Reading a day properly is the archive's job. */

const DAY_COUNT = 7;

/** Local calendar days, newest first. Noon keeps a DST shift from sliding the date. */
function recentDays(): string[] {
  return Array.from({ length: DAY_COUNT }, (_, back) => {
    const day = new Date();
    day.setHours(12, 0, 0, 0);
    day.setDate(day.getDate() - back);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  });
}

const dayLabel = (date: string, index: number) => (index === 0 ? `today · ${dayStamp(date)}` : dayStamp(date));

export function DiaryShelf({
  open,
  onClose,
  onInsert,
  onOpenArchive,
}: {
  open: boolean;
  onClose: () => void;
  onInsert: (text: string) => void;
  onOpenArchive: () => void;
}) {
  const { diaries, error, loading } = useDiaries(open);
  const written = new Map(diaries.map((entry) => [entry.date, entry]));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const days = recentDays();

  const bring = () => {
    const chips = days
      .map((date, index) => ({ date, index, entry: written.get(date) }))
      .filter((row) => picked.has(row.date) && row.entry)
      .map(({ date, index, entry }) => ({ date, title: entry!.title, today: index === 0 }));
    if (chips.length === 0) return;
    onInsert(diaryNote(chips));
    setPicked(new Set());
    onClose();
  };

  return (
    <Shelf open={open} onClose={onClose} title="diaries" sub="the days they wrote down">
      <span className="shelf-label">the last seven days</span>
      {error && <p className="shelf-note" role="alert">the shelf wouldn’t open · {error}</p>}
      <div className="shelf-days">
        {days.map((date, index) => {
          const entry = written.get(date);
          const on = picked.has(date);
          return (
            <button
              key={date}
              type="button"
              className={cn("shelf-day", on && "is-picked", !entry && "is-blank")}
              disabled={!entry}
              aria-pressed={on}
              onClick={() =>
                setPicked((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(date)) next.add(date);
                  return next;
                })
              }
            >
              <span className="shelf-tick" aria-hidden>{on && <IconCheck size={11} />}</span>
              <span className="shelf-day-lines">
                <em>{dayLabel(date, index)}</em>
                <b>{entry?.title ?? (loading ? "…" : "nothing written yet")}</b>
                {on && entry?.excerpt && <p>{entry.excerpt}</p>}
              </span>
            </button>
          );
        })}
      </div>
      <div className="shelf-foot">
        <button type="button" className="shelf-bring" disabled={picked.size === 0} onClick={bring}>
          {picked.size === 0 ? "pick a day to bring in" : `bring ${picked.size} day${picked.size > 1 ? "s" : ""} into the talk`}
        </button>
        <button type="button" className="shelf-archive" onClick={onOpenArchive}>open the archive →</button>
      </div>
    </Shelf>
  );
}
