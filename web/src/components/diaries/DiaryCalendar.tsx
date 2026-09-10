import { useState } from "react";
import { diaryWeight } from "@/lib/diaries/format";
import { cn } from "@/lib/utils";
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconChevronUp } from "../organicIcons";

/** Diaries 1a: a month at a glance, tinted by how much was written. The month label drops a year
    of months with their counts, so anywhere in the archive is two clicks. */

const WEEKDAYS = ["m", "t", "w", "t", "f", "s", "s"];

export type MonthKey = string; // YYYY-MM

const monthDate = (key: MonthKey) => new Date(`${key}-01T00:00:00`);
const keyOf = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
const shift = (key: MonthKey, by: number) => keyOf(new Date(monthDate(key).getFullYear(), monthDate(key).getMonth() + by, 1));
const named = (key: MonthKey, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, options).format(monthDate(key)).toLowerCase();

export function DiaryCalendar({ month, onMonth, counts, weights, selected, onSelect }: {
  month: MonthKey;
  onMonth: (month: MonthKey) => void;
  /** days written per month, keyed YYYY-MM */
  counts: Map<MonthKey, number>;
  /** how long each written day is, keyed YYYY-MM-DD */
  weights: Map<string, number>;
  selected: string | undefined;
  onSelect: (date: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [year, setYear] = useState(() => monthDate(month).getFullYear());

  const written = [...counts.keys()].sort();
  const first = written[0] ?? month;
  const last = written[written.length - 1] ?? month;
  const step = (by: number) => {
    const next = shift(month, by);
    if (next >= first && next <= last) onMonth(next);
  };

  const start = monthDate(month);
  const offset = (start.getDay() + 6) % 7; // the week opens on monday
  const length = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const today = keyOf(new Date()) === month ? new Date().getDate() : 0;

  const yearDays = [...counts.entries()].filter(([key]) => key.startsWith(`${year}`)).reduce((sum, [, n]) => sum + n, 0);
  const yearStep = (by: number) => setYear((current) => current + by);

  return (
    <>
      <div className="cal-bar">
        <button type="button" className="cal-month" aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
          {named(month, { month: "long", year: "numeric" })}
          {picking ? <IconChevronUp size={13} /> : <IconChevronDown size={13} />}
        </button>
        <button type="button" className="cal-step" title={named(shift(month, -1), { month: "long" })}
          disabled={shift(month, -1) < first} onClick={() => step(-1)}>
          <IconChevronLeft size={14} />
        </button>
        <button type="button" className="cal-step" title={named(shift(month, 1), { month: "long" })}
          disabled={shift(month, 1) > last} onClick={() => step(1)}>
          <IconChevronRight size={14} />
        </button>
      </div>

      {picking && (
        <div className="cal-years">
          <div className="cal-years-head">
            <button type="button" title={`${year - 1}`} disabled={first.slice(0, 4) > `${year - 1}`} onClick={() => yearStep(-1)}>
              <IconChevronLeft size={12} />
            </button>
            <b>{year}</b>
            <button type="button" title={`${year + 1}`} disabled={last.slice(0, 4) < `${year + 1}`} onClick={() => yearStep(1)}>
              <IconChevronRight size={12} />
            </button>
            <span>{yearDays} {yearDays === 1 ? "day" : "days"} written</span>
          </div>
          <div className="cal-year-grid">
            {Array.from({ length: 12 }, (_, index) => {
              const key = `${year}-${String(index + 1).padStart(2, "0")}`;
              const count = counts.get(key) ?? 0;
              return (
                <button
                  key={key}
                  type="button"
                  className={cn("cal-year-month", key === month && "is-on")}
                  data-weight={count === 0 ? undefined : diaryWeight(count * 200)}
                  disabled={count === 0}
                  onClick={() => {
                    onMonth(key);
                    setPicking(false);
                  }}
                >
                  {named(key, { month: "short" })}
                  <span>{count || "—"}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="cal-grid">
        {WEEKDAYS.map((letter, index) => <span key={index} className="cal-weekday">{letter}</span>)}
        {Array.from({ length: offset }, (_, index) => <span key={`pad${index}`} />)}
        {Array.from({ length }, (_, index) => {
          const date = `${month}-${String(index + 1).padStart(2, "0")}`;
          const size = weights.get(date);
          return (
            <button
              key={date}
              type="button"
              className={cn("cal-day", date === selected && "is-on", today === index + 1 && "is-today")}
              data-weight={size === undefined ? undefined : diaryWeight(size)}
              disabled={size === undefined}
              onClick={() => onSelect(date)}
            >
              {index + 1}
            </button>
          );
        })}
      </div>
    </>
  );
}
