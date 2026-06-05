import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, RefreshCw } from "lucide-react";
import { DiaryListButton } from "@/components/diaries/DiaryListButton";
import { DiaryReader } from "@/components/diaries/DiaryReader";
import { EmptyState, InitialDiarySkeleton } from "@/components/diaries/DiaryStates";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchDiaries, fetchDiary, type DiaryEntry, type DiarySummary } from "@/lib/api";
import { cn } from "@/lib/utils";

export function DiariesPage({ nav }: { nav?: ReactNode }) {
  const [diaries, setDiaries] = useState<DiarySummary[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | undefined>();
  const [entry, setEntry] = useState<DiaryEntry | undefined>();
  const [loadingList, setLoadingList] = useState(true);
  const [loadingEntry, setLoadingEntry] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [mobileReader, setMobileReader] = useState(false);
  const [userSwitched, setUserSwitched] = useState(false);

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
    if (!selectedDate || entry?.date === selectedDate) return;
    const id = window.setTimeout(() => void loadEntry(selectedDate), 0);
    return () => window.clearTimeout(id);
  }, [entry?.date, loadEntry, selectedDate]);

  const selectedSummary = diaries.find((diary) => diary.date === selectedDate);
  const currentContent = entry && entry.date === selectedDate ? entry.content : undefined;
  const showInitialSkeleton = loadingList && diaries.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="border-b border-border bg-background px-3 py-3 md:px-8">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          {nav}
          <div className="min-w-0 flex-1">
            <p className="font-serif text-2xl leading-tight tracking-tight">diaries</p>
            <p className="mt-0.5 font-serif text-xs italic text-muted-foreground">written days, kept close</p>
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
        <p className="border-b border-border bg-card px-3 py-2 font-serif text-xs italic text-destructive md:px-8">
          {error}
        </p>
      ) : null}
      {showInitialSkeleton ? (
        <InitialDiarySkeleton />
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
                      if (diary.date !== selectedDate) setUserSwitched(true);
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
                settle={userSwitched}
              />
            </ScrollArea>
          </main>
        </div>
      )}
    </div>
  );
}
