import { useState, type ReactNode } from "react";
import { Composer } from "./Composer";
import { ConfigDrawer } from "./ConfigDrawer";
import { Header } from "./Header";
import { MessageList } from "./MessageList";
import { useChat } from "@/lib/useChat";
import type { WebAuthDevice } from "@/lib/api";

export function Chat({
  nav,
  authMode,
  authDevice,
  onSignedOut,
}: {
  nav?: ReactNode;
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
    notifyNewChat,
  } = useChat();
  const [configOpen, setConfigOpen] = useState(false);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground antialiased">
      <Header
        nav={nav}
        connection={connection}
        personaName={personaName}
        sessions={sessions}
        activeSessionKey={activeSessionKey}
        channelKey={activeSessionKey}
        onSelectSession={selectSession}
        onOpenConfig={() => setConfigOpen(true)}
        onNewChatStarted={notifyNewChat}
      />
      <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
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
      </main>
      <Composer
        onSend={send}
        onAbort={abort}
        streaming={streaming}
        personaName={personaName}
      />
      <ConfigDrawer
        open={configOpen}
        onOpenChange={setConfigOpen}
        channelKey={activeSessionKey}
        authMode={authMode}
        authDevice={authDevice}
        onSignedOut={onSignedOut}
      />
    </div>
  );
}
