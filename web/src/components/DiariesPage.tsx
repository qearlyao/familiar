import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { BookOpen, CalendarDays, FileText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { fetchDiaries, fetchDiary, type DiaryEntry, type DiarySummary } from "@/lib/api";

function formatDiaryDate(date: string, style: "short" | "long" = "long"): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(undefined, {
    weekday: style === "long" ? "long" : undefined,
    month: style === "long" ? "long" : "short",
    day: "numeric",
    year: style === "long" ? "numeric" : undefined,
  })
    .format(parsed)
    .toLowerCase();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} b`;
  return `${Math.round(bytes / 1024)} kb`;
}

function LoadingRows() {
  return (
    <div className="grid gap-2 px-2 py-1">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="rounded-md bg-muted/70 px-3 py-3">
          <div className="h-3 w-24 rounded-sm bg-muted-foreground/15" />
          <div className="mt-3 h-2 w-full rounded-sm bg-muted-foreground/10" />
          <div className="mt-2 h-2 w-2/3 rounded-sm bg-muted-foreground/10" />
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
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "w-full rounded-md px-3 py-3 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        active
          ? "bg-primary text-primary-foreground"
          : "text-foreground hover:bg-accent/60",
      )}
    >
      <span className="flex items-center gap-2 text-xs leading-none">
        <CalendarDays className="size-3.5" />
        <span>{formatDiaryDate(diary.date, "short")}</span>
      </span>
      <span className="mt-2 block truncate font-serif text-sm leading-tight tracking-tight">
        {diary.title}
      </span>
      {diary.excerpt ? (
        <span
          className={cn(
            "mt-1.5 line-clamp-2 text-xs leading-relaxed",
            active ? "text-primary-foreground/75" : "text-muted-foreground",
          )}
        >
          {diary.excerpt}
        </span>
      ) : null}
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
  return (
    <article
      key={summary.date}
      className="mx-auto flex w-full max-w-3xl flex-col px-6 py-8 duration-200 ease-out-quart animate-in fade-in-0 slide-in-from-bottom-[0.375rem] motion-reduce:animate-none md:px-8 md:py-10"
    >
      <div className="mb-8 border-b border-border pb-6">
        <p className="font-serif text-sm italic text-muted-foreground">{formatDiaryDate(summary.date)}</p>
        <h1 className="mt-3 max-w-[18ch] font-serif text-3xl leading-tight tracking-tight text-foreground">
          {summary.title}
        </h1>
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <FileText className="size-3.5" />
          {summary.sourceId}, {formatSize(summary.sizeBytes)}
        </p>
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
          <LoadingRows />
          <div className="rounded-md bg-card p-8">
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
        <div className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-5 overflow-hidden px-4 py-5 md:grid-cols-[18rem_minmax(0,1fr)] md:px-8">
          <aside className="min-h-0 rounded-md bg-card py-2 shadow-sm">
            <ScrollArea className="h-full max-h-56 md:max-h-none">
              <div className="grid gap-1 px-2">
                {diaries.map((diary) => (
                  <DiaryListButton
                    key={diary.date}
                    diary={diary}
                    active={diary.date === selectedDate}
                    onSelect={() => setSelectedDate(diary.date)}
                  />
                ))}
              </div>
            </ScrollArea>
          </aside>
          <main className="min-h-0 overflow-hidden rounded-md bg-card shadow-sm">
            <ScrollArea className="h-full">
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
