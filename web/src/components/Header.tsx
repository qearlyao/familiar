import { ContextRing, SessionPicker } from "./SessionPicker";
import { QuickSettings } from "./QuickSettings";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/lib/useMediaQuery";
import type { ConnectionState, SessionInfo } from "@/lib/api";

const DESKTOP = "(min-width: 768px)";

const STATUS: Record<ConnectionState, string> = {
  connecting: "reaching out…",
  open: "here with you · listening",
  closed: "out of touch · trying again",
  error: "out of touch · trying again",
};

export function Header({
  connection,
  personaName,
  sessions,
  activeSessionKey,
  onSelectSession,
  onNewChat,
  onOpenSettings,
  streaming,
}: {
  connection: ConnectionState;
  personaName: string;
  sessions: SessionInfo[];
  activeSessionKey: string | undefined;
  onSelectSession: (key: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  streaming: boolean;
}) {
  const live = connection === "open";
  const desktop = useMediaQuery(DESKTOP);
  const context = sessions.find((s) => s.key === activeSessionKey)?.context;
  const picker = <SessionPicker desktop={desktop} sessions={sessions} activeKey={activeSessionKey} onSelect={onSelectSession} onNewChat={onNewChat} />;

  return (
    <header className="chat-header">
      <div className="chat-persona-avatar" aria-hidden="true">
        {personaName.slice(0, 1).toUpperCase()}
        <span className={cn("chat-presence", !live && "is-away")} />
      </div>
      <div className="chat-persona">
        <h1>{personaName}</h1>
        <p role="status">{live && streaming ? "here with you · thinking" : STATUS[connection]}</p>
        {!desktop && picker}
      </div>
      <div className="chat-header-actions">
        {context && <ContextRing {...context} />}
        {desktop && picker}
        <QuickSettings channelKey={activeSessionKey} onOpenSettings={onOpenSettings} />
      </div>
    </header>
  );
}
