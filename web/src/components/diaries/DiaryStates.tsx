import { BookOpen, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function LoadingRows() {
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

export function InitialDiarySkeleton() {
  return (
    <div className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-6 overflow-hidden px-4 py-5 md:grid-cols-[18rem_minmax(0,1fr)] md:px-8 low-dpr-wide:max-w-[clamp(72rem,62vw,88rem)]">
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
  );
}

export function EmptyState({ onRefresh }: { onRefresh: () => void }) {
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
