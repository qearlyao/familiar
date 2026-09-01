import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
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

function ContextRing({ tokens, limit, large = false }: { tokens: number; limit: number; large?: boolean }) {
  const fraction = Math.min(tokens / limit, 1);
  const percent = Math.round(fraction * 100);
  const details = `${percent}% of the context window - ${tokens.toLocaleString()} / ${limit.toLocaleString()} tokens`;
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        type="button"
        aria-label={`context ${percent}% full`}
        className={cn(
          "inline-flex shrink-0 rounded-sm text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/30",
          large ? "size-8 items-center justify-center" : "",
        )}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <svg viewBox="0 0 14 14" className={cn(large ? "size-5" : "size-3.5", "-rotate-90")} aria-hidden="true">
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
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="center"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-card-foreground shadow-md"
        >
          {details}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
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
  if (sessions.length <= 1) {
    const context = sessions[0]?.context;
    return context ? <ContextRing tokens={context.tokens} limit={context.limit} large /> : null;
  }
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
