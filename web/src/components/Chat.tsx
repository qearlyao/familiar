import { useState } from "react";
import { Composer } from "./Composer";
import { ConfigDrawer } from "./ConfigDrawer";
import { Header } from "./Header";
import { MessageList } from "./MessageList";
import { useChat } from "@/lib/useChat";
import type { WebAuthDevice } from "@/lib/api";

export function Chat({
  authMode,
  authDevice,
  onSignedOut,
}: {
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
    selectSession,
    send,
    abort,
    retry,
    deleteLatest,
    notifyNewChat,
  } = useChat();
  const [configOpen, setConfigOpen] = useState(false);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground antialiased">
      <Header
        connection={connection}
        personaName={personaName}
        sessions={sessions}
        activeSessionKey={activeSessionKey}
        channelKey={activeSessionKey}
        onSelectSession={selectSession}
        onOpenConfig={() => setConfigOpen(true)}
        onNewChatStarted={notifyNewChat}
      />
      <main className="flex-1 overflow-y-auto">
        <MessageList
          messages={messages}
          personaName={personaName}
          historyLoaded={historyLoaded}
          streaming={streaming}
          onRetry={retry}
          onDelete={deleteLatest}
        />
      </main>
      <Composer
        onSend={(text, attachments) => void send(text, attachments)}
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
