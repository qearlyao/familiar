import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetchSessions, type SessionInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

function sessionLabel(s: SessionInfo): string {
  if (s.label) return s.label;
  if (s.scope === "dm") return "Main Chat";
  return s.channelName ?? s.channelId;
}

const RING_RADIUS = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ContextRing({ tokens, limit }: { tokens: number; limit: number }) {
  const fraction = Math.min(tokens / limit, 1);
  const percent = Math.round(fraction * 100);
  return (
    <span
      className="inline-flex shrink-0"
      title={`${percent}% of the context window — ${tokens.toLocaleString()} / ${limit.toLocaleString()} tokens`}
    >
      <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90" role="img" aria-label={`context ${percent}% full`}>
        <circle cx="7" cy="7" r={RING_RADIUS} fill="none" strokeWidth="2" className="stroke-border" />
        <circle
          cx="7"
          cy="7"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
          className={fraction >= 0.8 ? "stroke-destructive" : "stroke-primary"}
        />
      </svg>
    </span>
  );
}

export function SessionPicker({
  sessions,
  activeKey,
  onSelect,
}: {
  sessions: SessionInfo[];
  activeKey: string | undefined;
  onSelect: (key: string) => void;
}) {
  // ponytail: refetch on open so the rings are fresh; stale prop data shows until it lands
  const [fresh, setFresh] = useState<SessionInfo[] | null>(null);
  if (sessions.length <= 1) return null;
  const list = fresh ?? sessions;
  const active = sessions.find((s) => s.key === activeKey);
  const label = active ? sessionLabel(active) : "select session";

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open)
          fetchSessions()
            .then(setFresh)
            .catch(() => undefined);
      }}
    >
      <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/30">
        <span className="font-medium">{label}</span>
        <ChevronDown className="size-3 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[180px]"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {list.map((s) => {
          const isActive = s.key === activeKey;
          return (
            <DropdownMenuItem
              key={s.key}
              onSelect={() => onSelect(s.key)}
              className="flex items-center justify-between gap-3"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className={cn("truncate", isActive && "font-medium")}>{sessionLabel(s)}</span>
                {s.context && <ContextRing tokens={s.context.tokens} limit={s.context.limit} />}
              </span>
              {isActive && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
