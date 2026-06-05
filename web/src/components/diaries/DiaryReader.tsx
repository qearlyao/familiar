import type { DiarySummary } from "@/lib/api";
import { diaryRecency, formatDiaryDate, readingTime } from "@/lib/diaries/format";
import { cn } from "@/lib/utils";
import { MarkdownView } from "./MarkdownView";

export function ReaderBodySkeleton() {
  return (
    <div className="mt-2 space-y-3" aria-hidden>
      <div className="h-3 w-full rounded-sm bg-muted-foreground/10" />
      <div className="h-3 w-11/12 rounded-sm bg-muted-foreground/10" />
      <div className="h-3 w-4/5 rounded-sm bg-muted-foreground/10" />
      <div className="h-3 w-2/3 rounded-sm bg-muted-foreground/10" />
    </div>
  );
}

export function DiaryReader({
  summary,
  content,
  loading,
  settle,
}: {
  summary: DiarySummary | undefined;
  content: string | undefined;
  loading: boolean;
  settle: boolean;
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
      className={cn(
        "mx-auto flex w-full max-w-[70ch] flex-col px-6 py-8 md:px-8 md:py-10",
        settle &&
          "duration-200 ease-out-quart animate-in fade-in-0 slide-in-from-bottom-[0.375rem] motion-reduce:animate-none",
      )}
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
