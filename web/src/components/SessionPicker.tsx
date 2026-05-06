import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SessionInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

function sessionLabel(s: SessionInfo): string {
  if (s.label) return s.label;
  if (s.scope === "dm") return "Main Chat";
  return s.channelName ?? s.channelId;
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
  if (sessions.length <= 1) return null;
  const active = sessions.find((s) => s.key === activeKey);
  const label = active ? sessionLabel(active) : "select session";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/30">
        <span className="font-medium">{label}</span>
        <ChevronDown className="size-3 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        {sessions.map((s) => {
          const isActive = s.key === activeKey;
          return (
            <DropdownMenuItem
              key={s.key}
              onSelect={() => onSelect(s.key)}
              className="flex items-center justify-between gap-3"
            >
              <span className={cn("truncate", isActive && "font-medium")}>{sessionLabel(s)}</span>
              {isActive && <Check className="size-3.5 text-muted-foreground" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
