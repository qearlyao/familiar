import { ThemeToggle } from "./ThemeToggle";
import { SessionPicker } from "./SessionPicker";
import { cn } from "@/lib/utils";
import type { ConnectionState, SessionInfo } from "@/lib/api";

const STATUS_LABEL: Record<ConnectionState, string> = {
  connecting: "connecting",
  open: "online",
  closed: "offline",
  error: "error",
};

export function Header({
  connection,
  personaName,
  sessions,
  activeSessionKey,
  onSelectSession,
}: {
  connection: ConnectionState;
  personaName: string;
  sessions: SessionInfo[];
  activeSessionKey: string | undefined;
  onSelectSession: (key: string) => void;
}) {
  const live = connection === "open";

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-3">
        <span
          aria-label={STATUS_LABEL[connection]}
          title={STATUS_LABEL[connection]}
          className={cn(
            "size-2 rounded-full ring-3 ring-accent/60",
            live ? "bg-primary" : "bg-muted-foreground/40 ring-transparent",
          )}
        />
        <span className="font-serif text-lg leading-none tracking-tight">{personaName}</span>
        <div className="ml-auto flex items-center gap-1">
          <SessionPicker sessions={sessions} activeKey={activeSessionKey} onSelect={onSelectSession} />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
