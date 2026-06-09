import { Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { NewChatButton } from "./NewChatButton";
import { SessionPicker } from "./SessionPicker";
import { cn } from "@/lib/utils";
import type { ConnectionState, SessionInfo } from "@/lib/api";

const STATUS_LABEL: Record<ConnectionState, string> = {
  connecting: "connecting",
  open: "online",
  closed: "offline",
  error: "error",
};

const STATUS_VOICE: Record<Exclude<ConnectionState, "open">, string> = {
  connecting: "reaching out…",
  closed: "out of touch · trying again",
  error: "out of touch · trying again",
};

export function Header({
  nav,
  connection,
  personaName,
  sessions,
  activeSessionKey,
  channelKey,
  onSelectSession,
  onOpenConfig,
  onNewChatStarted,
}: {
  nav?: ReactNode;
  connection: ConnectionState;
  personaName: string;
  sessions: SessionInfo[];
  activeSessionKey: string | undefined;
  channelKey: string | undefined;
  onSelectSession: (key: string) => void;
  onOpenConfig: () => void;
  onNewChatStarted: () => void;
}) {
  const live = connection === "open";

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background px-3 py-3 md:px-5">
      <div className="chat-frame flex items-center gap-3">
        {nav}
        <span
          aria-label={STATUS_LABEL[connection]}
          title={STATUS_LABEL[connection]}
          className={cn(
            "size-2 rounded-full ring-3 ring-accent/60",
            live ? "bg-primary" : "bg-muted-foreground/40 ring-transparent",
          )}
        />
        <span className="font-serif text-lg leading-none tracking-tight">{personaName}</span>
        {!live && (
          <span className="font-serif text-xs italic leading-none text-muted-foreground/80">
            {STATUS_VOICE[connection]}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <SessionPicker sessions={sessions} activeKey={activeSessionKey} onSelect={onSelectSession} />
          <NewChatButton channelKey={channelKey} onStarted={onNewChatStarted} />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="settings"
            title="settings"
            className="size-8 text-muted-foreground hover:text-foreground"
            onClick={onOpenConfig}
          >
            <Settings2 className="size-4" />
          </Button>
        </div>
      </div>
    </header>
  );
}
