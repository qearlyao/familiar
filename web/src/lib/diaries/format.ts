function parseDiaryDate(date: string): Date | null {
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDiaryDate(date: string): string {
  const parsed = parseDiaryDate(date);
  if (!parsed) return date;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  })
    .format(parsed)
    .toLowerCase();
}

/** "wed 9 sept" — a day named the way it is spoken. */
export function dayStamp(date: string): string {
  const parsed = parseDiaryDate(date);
  if (!parsed) return date;
  return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" })
    .format(parsed)
    .toLowerCase();
}

/** What a day hands to the composer when it is brought into the talk: the days named, not their
    text — the agent decides whether to recall them or open the pages in full. */
export function diaryNote(days: { date: string; title: string; today?: boolean }[]): string {
  const one = days.length === 1;
  const lines = days.map(({ date, title, today }) => `· ${today ? `today · ${dayStamp(date)}` : dayStamp(date)} — ${title}`);
  return [
    one
      ? "a diary chip, so you can place where we are — recall it, or open the day in full if you'd rather:"
      : "diary chips, so you can place where we are — recall them, or open the days in full if you'd rather:",
    ...lines,
  ].join("\n");
}

/** How much was written that day, in the three steps the calendar tints by. */
export function diaryWeight(sizeBytes: number): 1 | 2 | 3 {
  return sizeBytes < 900 ? 1 : sizeBytes < 3600 ? 2 : 3;
}
