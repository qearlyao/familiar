export interface DiaryDateParts {
  weekday: string;
  day: string;
  month: string;
}

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

export function diaryDateParts(date: string): DiaryDateParts {
  const parsed = parseDiaryDate(date);
  if (!parsed) return { weekday: "", day: date, month: "" };
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(undefined, options).format(parsed).toLowerCase();
  return {
    weekday: part({ weekday: "short" }),
    day: part({ day: "numeric" }),
    month: part({ month: "short" }),
  };
}

export function daysSinceDiary(date: string): number | null {
  const parsed = parseDiaryDate(date);
  if (!parsed) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - parsed.getTime()) / 86_400_000);
}

export function diaryRecency(date: string): string | undefined {
  const diff = daysSinceDiary(date);
  if (diff === null || diff < 0) return undefined;
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return `${diff} days ago`;
  if (diff < 14) return "last week";
  if (diff < 30) return `${Math.round(diff / 7)} weeks ago`;
  if (diff < 60) return "last month";
  if (diff < 365) return `${Math.round(diff / 30)} months ago`;
  return undefined;
}

export function readingTime(content: string): string {
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return "";
  const minutes = Math.max(1, Math.round(words / 200));
  return minutes === 1 ? "a minute’s read" : `a ${minutes}-minute read`;
}
