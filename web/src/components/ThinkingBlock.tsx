import { useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface ThinkingBlockProps {
  text: string;
  durationMs?: number;
  streaming?: boolean;
  defaultOpen?: boolean;
}

function formatDuration(ms?: number): string {
  if (ms == null) return "thinking…";
  if (ms < 1000) return `thought for <1s`;
  const s = Math.round(ms / 100) / 10;
  return `thought for ${s}s`;
}

export function ThinkingBlock({
  text,
  durationMs,
  streaming,
  defaultOpen,
}: ThinkingBlockProps) {
  const [open, setOpen] = useState<boolean>(defaultOpen ?? Boolean(streaming));

  if (!text && !streaming) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1 mb-3">
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground/55 transition-colors hover:text-muted-foreground">
        <ChevronRight
          className={cn(
            "size-3 transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <span>{streaming ? "thinking…" : formatDuration(durationMs)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 border-l-2 border-border pl-3 italic font-serif text-[0.95em] leading-relaxed text-muted-foreground/80 whitespace-pre-wrap">
          {text}
          {streaming && <span className="ml-0.5 inline-block animate-pulse">▎</span>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
