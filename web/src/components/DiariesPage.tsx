import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { BookOpen, ChevronLeft, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { fetchDiaries, fetchDiary, type DiaryEntry, type DiarySummary } from "@/lib/api";

function parseDiaryDate(date: string): Date | null {
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDiaryDate(date: string): string {
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

function diaryDateParts(date: string): { weekday: string; day: string; month: string } {
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

function daysSince(date: string): number | null {
  const parsed = parseDiaryDate(date);
  if (!parsed) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - parsed.getTime()) / 86_400_000);
}

function diaryRecency(date: string): string | undefined {
  const diff = daysSince(date);
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

function readingTime(content: string): string {
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return "";
  const minutes = Math.max(1, Math.round(words / 200));
  return minutes === 1 ? "a minute’s read" : `a ${minutes}-minute read`;
}

function LoadingRows() {
  return (
    <div className="grid gap-1 px-2 py-1">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex gap-3 rounded-md px-2 py-3">
          <div className="flex w-10 shrink-0 flex-col items-center gap-1 pt-0.5">
            <div className="h-2 w-7 rounded-sm bg-muted-foreground/10" />
            <div className="h-5 w-6 rounded-sm bg-muted-foreground/15" />
            <div className="h-2 w-6 rounded-sm bg-muted-foreground/10" />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="h-3 w-2/3 rounded-sm bg-muted-foreground/15" />
            <div className="mt-2.5 h-2 w-full rounded-sm bg-muted-foreground/10" />
            <div className="mt-1.5 h-2 w-4/5 rounded-sm bg-muted-foreground/10" />
          </div>
        </div>
      ))}
    </div>
  );
}

function DiaryListButton({
  diary,
  active,
  onSelect,
}: {
  diary: DiarySummary;
  active: boolean;
  onSelect: () => void;
}) {
  const { weekday, day, month } = diaryDateParts(diary.date);
  const isToday = daysSince(diary.date) === 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full gap-3 rounded-md px-2 py-3 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent/50",
      )}
    >
      <span className="flex w-10 shrink-0 flex-col items-center font-serif leading-none">
        <span
          className={cn(
            "text-[0.6875rem] tracking-wide",
            active ? "text-primary-foreground/70" : "text-muted-foreground",
          )}
        >
          {weekday}
        </span>
        <span className="mt-0.5 text-2xl tabular-nums">{day}</span>
        <span
          className={cn(
            "mt-0.5 text-[0.6875rem] tracking-wide",
            active ? "text-primary-foreground/70" : "text-muted-foreground",
          )}
        >
          {month}
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="block truncate font-serif text-sm leading-tight tracking-tight">
            {diary.title}
          </span>
          {isToday ? (
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                active ? "bg-primary-foreground/70" : "bg-primary",
              )}
              aria-hidden
            />
          ) : null}
        </span>
        {diary.excerpt ? (
          <span
            className={cn(
              "mt-1.5 line-clamp-2 text-xs leading-relaxed",
              active ? "text-primary-foreground/85" : "text-muted-foreground",
            )}
          >
            {diary.excerpt}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function EmptyState({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="flex h-full min-h-[18rem] items-center justify-center px-6 text-center">
      <div className="max-w-sm">
        <BookOpen className="mx-auto size-7 text-muted-foreground" />
        <h2 className="mt-5 font-serif text-xl leading-tight tracking-tight">no written days yet</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          when dated diary files arrive in the diary folder, they will settle here newest first.
        </p>
        <Button type="button" variant="ghost" className="mt-5" onClick={onRefresh}>
          <RefreshCw className="size-4" />
          check again
        </Button>
      </div>
    </div>
  );
}

function splitInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(text.slice(cursor, index));
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (match[2]) parts.push(<code key={parts.length}>{value}</code>);
    else if (match[3]) parts.push(<strong key={parts.length}>{value}</strong>);
    else parts.push(<em key={parts.length}>{value}</em>);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function MarkdownView({ content, title }: { content: string; title: string }) {
  const blocks = useMemo(() => markdownBlocks(content, title), [content, title]);
  if (blocks.length === 0) {
    return <p className="font-serif text-sm italic text-muted-foreground">this day is quiet.</p>;
  }
  return <div className="diary-prose">{blocks}</div>;
}

function markdownBlocks(content: string, title: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const paragraph: string[] = [];
  let listItems: string[] = [];
  let listKind: "ul" | "ol" | undefined;
  let sawHeading = false;

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) nodes.push(<p key={nodes.length}>{splitInline(text)}</p>);
    paragraph.length = 0;
  };
  const flushList = () => {
    if (!listKind || listItems.length === 0) return;
    const Tag = listKind;
    nodes.push(
      <Tag key={nodes.length}>
        {listItems.map((item, index) => (
          <li key={index}>{splitInline(item)}</li>
        ))}
      </Tag>,
    );
    listItems = [];
    listKind = undefined;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (const rawLine of content.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? "";
      if (!sawHeading && normalizeHeadingText(text) === normalizeHeadingText(title)) {
        sawHeading = true;
        continue;
      }
      sawHeading = true;
      const Tag = level <= 2 ? "h2" : "h3";
      nodes.push(<Tag key={nodes.length}>{splitInline(text)}</Tag>);
      continue;
    }
    const unordered = /^[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const nextKind = unordered ? "ul" : "ol";
      if (listKind && listKind !== nextKind) flushList();
      listKind = nextKind;
      listItems.push((unordered?.[1] ?? ordered?.[1] ?? "").trim());
      continue;
    }
    const quote = /^>\s+(.+)$/.exec(line);
    if (quote) {
      flush();
      nodes.push(<blockquote key={nodes.length}>{splitInline(quote[1] ?? "")}</blockquote>);
      continue;
    }
    if (startsDiaryBeat(line) && paragraph.length > 0) {
      flushParagraph();
    }
    paragraph.push(line);
  }
  flush();
  return nodes;
}

function startsDiaryBeat(line: string): boolean {
  return /^(?:[A-Z][A-Za-z ]{0,32}\s+)?\(?\d{1,2}:\d{2}\)?\s*[:.)-]/.test(line);
}

function normalizeHeadingText(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#>]/g, "")
    .trim()
    .toLowerCase();
}

function ReaderBodySkeleton() {
  return (
    <div className="mt-2 space-y-3" aria-hidden>
      <div className="h-3 w-full rounded-sm bg-muted-foreground/10" />
      <div className="h-3 w-11/12 rounded-sm bg-muted-foreground/10" />
      <div className="h-3 w-4/5 rounded-sm bg-muted-foreground/10" />
      <div className="h-3 w-2/3 rounded-sm bg-muted-foreground/10" />
    </div>
  );
}

function DiaryReader({
  summary,
  content,
  loading,
}: {
  summary: DiarySummary | undefined;
  content: string | undefined;
  loading: boolean;
}) {
  if (!summary) {
    return (
      <div className="flex h-full min-h-[18rem] items-center justify-center px-6 text-center">
        <p className="font-serif text-sm italic text-muted-foreground">choose a written day.</p>
      </div>
    );
  }
  const recency = diaryRecency(summary.date);
  const reading = content !== undefined ? readingTime(content) : "";
  const meta = [recency, reading].filter(Boolean).join(" · ");
  return (
    <article
      key={summary.date}
      className="mx-auto flex w-full max-w-[70ch] flex-col px-6 py-8 duration-200 ease-out-quart animate-in fade-in-0 slide-in-from-bottom-[0.375rem] motion-reduce:animate-none md:px-8 md:py-10"
    >
      <div className="mb-8 border-b border-border pb-6">
        <p className="font-serif text-sm italic text-muted-foreground">{formatDiaryDate(summary.date)}</p>
        <h1 className="mt-3 font-serif text-3xl leading-tight tracking-tight text-balance text-foreground">
          {summary.title}
        </h1>
        {meta ? <p className="mt-3 font-serif text-xs italic text-muted-foreground">{meta}</p> : null}
      </div>
      {content !== undefined ? (
        <div className="duration-300 ease-out-quart animate-in fade-in-0 motion-reduce:animate-none">
          <MarkdownView content={content} title={summary.title} />
        </div>
      ) : loading ? (
        <ReaderBodySkeleton />
      ) : null}
    </article>
  );
}

export function DiariesPage() {
  const [diaries, setDiaries] = useState<DiarySummary[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | undefined>();
  const [entry, setEntry] = useState<DiaryEntry | undefined>();
  const [loadingList, setLoadingList] = useState(true);
  const [loadingEntry, setLoadingEntry] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [mobileReader, setMobileReader] = useState(false);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError(undefined);
    try {
      const next = await fetchDiaries();
      setDiaries(next);
      setSelectedDate((current) => {
        if (current && next.some((diary) => diary.date === current)) return current;
        return next[0]?.date;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadEntry = useCallback(async (date: string) => {
    setLoadingEntry(true);
    setError(undefined);
    try {
      setEntry(await fetchDiary(date));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntry(undefined);
    } finally {
      setLoadingEntry(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void loadList(), 0);
    return () => window.clearTimeout(id);
  }, [loadList]);

  useEffect(() => {
    if (!selectedDate) return;
    const id = window.setTimeout(() => void loadEntry(selectedDate), 0);
    return () => window.clearTimeout(id);
  }, [loadEntry, selectedDate]);

  const selectedSummary = diaries.find((diary) => diary.date === selectedDate);
  const currentContent = entry && entry.date === selectedDate ? entry.content : undefined;
  const showInitialSkeleton = loadingList && diaries.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="border-b border-border bg-background px-5 py-4 pl-14 md:px-8 md:pl-16">
        <div className="mx-auto flex max-w-6xl items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-serif text-2xl leading-tight tracking-tight">diaries</p>
            <p className="mt-1 font-serif text-xs italic text-muted-foreground">written days, kept close</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void loadList()}
            disabled={loadingList}
          >
            <RefreshCw className={cn("size-4", loadingList && "animate-spin")} />
            refresh
          </Button>
        </div>
      </header>
      {error ? (
        <p className="border-b border-border bg-card px-6 py-2 pl-14 font-serif text-xs italic text-destructive md:pl-16">
          {error}
        </p>
      ) : null}
      {showInitialSkeleton ? (
        <div className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-6 overflow-hidden px-4 py-5 md:grid-cols-[18rem_minmax(0,1fr)] md:px-8">
          <div className="rounded-md border border-border bg-card py-2">
            <LoadingRows />
          </div>
          <div className="rounded-md border border-border bg-card p-8">
            <div className="h-4 w-28 rounded-sm bg-muted-foreground/15" />
            <div className="mt-6 h-8 w-64 rounded-sm bg-muted-foreground/10" />
            <div className="mt-8 space-y-3">
              <div className="h-3 w-full rounded-sm bg-muted-foreground/10" />
              <div className="h-3 w-11/12 rounded-sm bg-muted-foreground/10" />
              <div className="h-3 w-3/4 rounded-sm bg-muted-foreground/10" />
            </div>
          </div>
        </div>
      ) : diaries.length === 0 ? (
        <EmptyState onRefresh={() => void loadList()} />
      ) : (
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 overflow-hidden px-4 py-5 md:flex-row md:px-8">
          <aside
            className={cn(
              "min-h-0 flex-col rounded-md border border-border bg-card py-2 md:flex md:w-72 md:flex-none",
              mobileReader ? "hidden md:flex" : "flex flex-1",
            )}
          >
            <ScrollArea className="min-h-0 flex-1">
              <div className="grid gap-1 px-2">
                {diaries.map((diary) => (
                  <DiaryListButton
                    key={diary.date}
                    diary={diary}
                    active={diary.date === selectedDate}
                    onSelect={() => {
                      setSelectedDate(diary.date);
                      setMobileReader(true);
                    }}
                  />
                ))}
              </div>
            </ScrollArea>
          </aside>
          <main
            className={cn(
              "min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card md:flex md:flex-1",
              mobileReader ? "flex flex-1" : "hidden md:flex",
            )}
          >
            <button
              type="button"
              onClick={() => setMobileReader(false)}
              className="flex items-center gap-1.5 border-b border-border px-4 py-2.5 text-left font-serif text-xs italic text-muted-foreground transition-colors hover:text-foreground md:hidden"
            >
              <ChevronLeft className="size-3.5" />
              all days
            </button>
            <ScrollArea className="min-h-0 flex-1">
              <DiaryReader
                summary={selectedSummary}
                content={currentContent}
                loading={loadingEntry}
              />
            </ScrollArea>
          </main>
        </div>
      )}
    </div>
  );
}
