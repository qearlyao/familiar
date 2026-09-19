import type { GalleryItem } from "@/lib/api";
import { mmss } from "@/lib/clock";

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
  entries: GalleryItem[];
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

export function formatDuration(seconds: number | undefined): string | undefined {
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? mmss(seconds) : undefined;
}

export function groupByTime(items: GalleryItem[], now: number): TimeGroup[] {
  const today = startOfDay(now);
  const groups: TimeGroup[] = [];
  const byKey = new Map<string, TimeGroup>();

  const push = (key: string, label: string, item: GalleryItem) => {
    let group = byKey.get(key);
    if (!group) {
      group = { key, label, entries: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.entries.push(item);
  };

  for (const item of items) {
    const day = startOfDay(item.createdAt);
    if (day >= today) {
      push("today", "today", item);
    } else if (day >= today - DAY_MS) {
      push("yesterday", "yesterday", item);
    } else if (day >= today - 6 * DAY_MS) {
      push("this-week", "earlier this week", item);
    } else {
      const d = new Date(item.createdAt);
      const sameYear = d.getFullYear() === new Date(now).getFullYear();
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const label = (sameYear ? MONTH : MONTH_YEAR).format(d).toLowerCase();
      push(key, label, item);
    }
  }

  return groups;
}
