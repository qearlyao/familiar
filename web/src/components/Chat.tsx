import { useState } from "react";
import { Composer } from "./Composer";
import { ConfigDrawer } from "./ConfigDrawer";
import { Header } from "./Header";
import { MessageList } from "./MessageList";
import { useChat } from "@/lib/useChat";

export function Chat() {
  const {
    messages,
    connection,
    personaName,
    sessions,
    activeSessionKey,
    selectSession,
    send,
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
        <MessageList messages={messages} />
      </main>
      <Composer
        onSend={(text, attachments) => void send(text, attachments)}
        personaName={personaName}
      />
      <ConfigDrawer
        open={configOpen}
        onOpenChange={setConfigOpen}
        channelKey={activeSessionKey}
      />
    </div>
  );
}
