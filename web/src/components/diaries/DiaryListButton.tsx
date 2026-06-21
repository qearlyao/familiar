import type { DiarySummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { daysSinceDiary, diaryDateParts } from "@/lib/diaries/format";

export function DiaryListButton({
  diary,
  active,
  onSelect,
}: {
  diary: DiarySummary;
  active: boolean;
  onSelect: () => void;
}) {
  const { weekday, day, month } = diaryDateParts(diary.date);
  const isToday = daysSinceDiary(diary.date) === 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-w-0 w-full gap-3 overflow-hidden rounded-md px-2 py-3 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
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
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="block min-w-0 flex-1 truncate font-serif text-sm leading-tight tracking-tight">
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
              "mt-1.5 block max-w-full break-words text-xs leading-relaxed line-clamp-2",
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
