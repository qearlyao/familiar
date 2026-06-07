import type { GalleryItem } from "@/lib/api";

const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const TIME_OF_DAY = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const LONG_DATE = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const LONG_DATE_YEAR = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});
const MONTH = new Intl.DateTimeFormat(undefined, { month: "long" });
const MONTH_YEAR = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

const DAY_MS = 86_400_000;

export interface TimeGroup {
  key: string;
  label: string;
  entries: { item: GalleryItem; index: number }[];
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatShortDate(ms: number): string {
  return SHORT_DATE.format(new Date(ms)).toLowerCase();
}

export function formatWhen(ms: number, now: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const datePart = (sameYear ? LONG_DATE : LONG_DATE_YEAR).format(d);
  return `${datePart} · ${TIME_OF_DAY.format(d)}`.toLowerCase();
}

export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || bytes <= 0) return undefined;
  if (bytes < 1024) return `${bytes} b`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} kb`;
  return `${(kb / 1024).toFixed(1)} mb`;
}

export function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

export function groupByTime(items: GalleryItem[], now: number): TimeGroup[] {
  const today = startOfDay(now);
  const groups: TimeGroup[] = [];
  const byKey = new Map<string, TimeGroup>();

  const push = (key: string, label: string, item: GalleryItem, index: number) => {
    let group = byKey.get(key);
    if (!group) {
      group = { key, label, entries: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.entries.push({ item, index });
  };

  items.forEach((item, index) => {
    const day = startOfDay(item.createdAt);
    if (day >= today) {
      push("today", "today", item, index);
    } else if (day >= today - DAY_MS) {
      push("yesterday", "yesterday", item, index);
    } else if (day >= today - 6 * DAY_MS) {
      push("this-week", "earlier this week", item, index);
    } else {
      const d = new Date(item.createdAt);
      const sameYear = d.getFullYear() === new Date(now).getFullYear();
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const label = (sameYear ? MONTH : MONTH_YEAR).format(d).toLowerCase();
      push(key, label, item, index);
    }
  });

  return groups;
}
