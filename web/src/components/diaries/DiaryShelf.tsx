import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { fetchDiaries, type DiarySummary } from "@/lib/api";
import { diaryDateParts } from "@/lib/diaries/format";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { cn } from "@/lib/utils";
import { Sheet } from "../Sheet";
import { IconCheck, IconX } from "../organicIcons";

/** Diaries 1c + Chat 1a: the last seven days, held open over the talk. Ticking days
    drops a note in the draft naming them — the agent decides whether to recall them
    or open the pages in full. Reading a day properly is the archive's job.

    Desktop keeps it inline beside the talk, so it stays a plain aside; a phone raises the
    same panel as a sheet, which wants a dialog's overlay, focus trap and exit run. */

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

function dayLabel(date: string, index: number): string {
  const { weekday, day, month } = diaryDateParts(date);
  const stamp = `${weekday} ${day} ${month}`;
  return index === 0 ? `today · ${stamp}` : stamp;
}

function chipNote(picked: { date: string; index: number; title: string }[]): string {
  const lines = picked.map(({ date, index, title }) => `· ${dayLabel(date, index)} — ${title}`);
  return [
    "diary chips, so you can place where we are — recall them, or open the days in full if you'd rather:",
    ...lines,
  ].join("\n");
}

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
  // The shelf takes 354px off the talk, so it goes to a sheet long before the rail does — the
  // conversation is what has to stay readable, not the column beside it. Under 1200 the header
  // starts wrapping its status line, so that is where the shelf stops being a column. (The mock
  // draws this layout at 1240.)
  const sheet = useMediaQuery("(max-width: 1199.98px)");
  const [written, setWritten] = useState<Map<string, DiarySummary>>(new Map());
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const days = recentDays();

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchDiaries()
      .then((all) => {
        if (!live) return;
        setWritten(new Map(all.map((entry) => [entry.date, entry])));
      })
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [open]);

  const bring = () => {
    const chips = days
      .map((date, index) => ({ date, index, entry: written.get(date) }))
      .filter((row) => picked.has(row.date) && row.entry)
      .map(({ date, index, entry }) => ({ date, index, title: entry!.title }));
    if (chips.length === 0) return;
    onInsert(chipNote(chips));
    setPicked(new Set());
    onClose();
  };

  const heading = <b>diaries</b>;
  const panel = (
    <>
      <span className="shelf-grab" aria-hidden />
      <header className="shelf-head">
        <div>
          {sheet ? <Dialog.Title asChild>{heading}</Dialog.Title> : heading}
          <span>the days they wrote down</span>
        </div>
        <button type="button" className="shelf-close" aria-label="close the shelf" title="close the shelf" onClick={onClose}>
          <IconX size={15} />
        </button>
      </header>
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
    </>
  );

  if (sheet) {
    return (
      <Sheet open={open} onOpenChange={(next) => !next && onClose()} className="diary-shelf">
        {panel}
      </Sheet>
    );
  }

  if (!open) return null;
  return (
    <aside className="diary-shelf" aria-label="diaries">
      {panel}
    </aside>
  );
}
