import { Composer } from "./Composer";
import { Header } from "./Header";
import { MessageList } from "./MessageList";
import { SettingsSurface } from "./SettingsSurface";
import { useChat } from "@/lib/useChat";
import type { WebAuthDevice } from "@/lib/api";

export function Chat({
  settingsOpen,
  onSettingsOpenChange,
  authMode,
  authDevice,
  onSignedOut,
}: {
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  authMode?: string;
  authDevice?: WebAuthDevice;
  onSignedOut?: () => void;
}) {
  const {
    messages,
    connection,
    personaName,
    sessions,
    activeSessionKey,
    historyLoaded,
    streaming,
    pendingLatestAssistantAction,
    selectSession,
    send,
    abort,
    retry,
    deleteLatest,
    editLatest,
  } = useChat();

  // key flips with the mode, so the room remounts on the way in and out — as it did when these were two returns.
  return (
    <div key={settingsOpen ? "settings" : "chat"} className="chat-room room-view flex h-full min-h-0 min-w-0 flex-col overflow-hidden antialiased">
      {settingsOpen ? (
        <SettingsSurface
          channelKey={activeSessionKey}
          authMode={authMode}
          authDevice={authDevice}
          onSignedOut={onSignedOut}
          onClose={() => onSettingsOpenChange(false)}
        />
      ) : (<>
        <Header
          streaming={streaming}
          connection={connection}
          personaName={personaName}
          sessions={sessions}
          activeSessionKey={activeSessionKey}
          onSelectSession={selectSession}
          onOpenSettings={() => onSettingsOpenChange(true)}
        />
        <div className="chat-divider" />
        <MessageList
          messages={messages}
          personaName={personaName}
          historyLoaded={historyLoaded}
          streaming={streaming}
          pendingLatestAssistantAction={pendingLatestAssistantAction}
          onRetry={retry}
          onDelete={deleteLatest}
          onEdit={editLatest}
        />
        <Composer onSend={send} onAbort={abort} streaming={streaming} />
      </>)}
    </div>
  );
}
