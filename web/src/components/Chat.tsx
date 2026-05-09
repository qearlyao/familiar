import { Composer } from "./Composer";
import { Header } from "./Header";
import { MessageList } from "./MessageList";
import { useChat } from "@/lib/useChat";

export function Chat() {
  const { messages, connection, personaName, sessions, activeSessionKey, selectSession, send } = useChat();

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground antialiased">
      <Header
        connection={connection}
        personaName={personaName}
        sessions={sessions}
        activeSessionKey={activeSessionKey}
        onSelectSession={selectSession}
      />
      <main className="flex-1 overflow-y-auto">
        <MessageList messages={messages} />
      </main>
      <Composer onSend={(text, attachments) => void send(text, attachments)} personaName={personaName} />
    </div>
  );
}
