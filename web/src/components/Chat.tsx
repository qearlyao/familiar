import type { RefObject } from "react";
import { Composer, type ComposerHandle } from "./Composer";
import { DiaryShelf } from "./diaries/DiaryShelf";
import { SkillShelf } from "./SkillShelf";
import { Header } from "./Header";
import { MessageList } from "./MessageList";
import { SettingsSurface } from "./SettingsSurface";
import { useChat } from "@/lib/useChat";
import type { WebAuthDevice } from "@/lib/api";

/** the rooms that can be held open beside the talk instead of replacing it */
export type ShelfName = "diaries" | "skills";

export function Chat({
  composer,
  settingsOpen,
  onSettingsOpenChange,
  shelf,
  onShelfChange,
  onOpenArchive,
  authMode,
  authDevice,
  onSignedOut,
}: {
  /** the draft, held by the shell so the archive can drop a day into it too */
  composer: RefObject<ComposerHandle | null>;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  shelf: ShelfName | undefined;
  onShelfChange: (shelf: ShelfName | undefined) => void;
  onOpenArchive: (page: ShelfName) => void;
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
    notifyNewChat,
    send,
    abort,
    retry,
    deleteLatest,
    editLatest,
  } = useChat();

  // key flips with the mode, so the room remounts on the way in and out — as it did when these were two returns.
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <div key={settingsOpen ? "settings" : "chat"} className="chat-room room-view flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden antialiased">
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
            onNewChat={notifyNewChat}
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
          <Composer onSend={send} onAbort={abort} streaming={streaming} handle={composer} />
        </>)}
      </div>
      {/* both stay mounted so a closing sheet can run its exit, and so one shelf can fade into the other */}
      {!settingsOpen && (
        <div className="shelf-slot" data-open={shelf ? "" : undefined}>
        <DiaryShelf
          open={shelf === "diaries"}
          onClose={() => onShelfChange(undefined)}
          onInsert={(text) => composer.current?.append(text)}
          onOpenArchive={() => onOpenArchive("diaries")}
        />
        <SkillShelf
          open={shelf === "skills"}
          onClose={() => onShelfChange(undefined)}
          personaName={personaName}
          onOpenArchive={() => onOpenArchive("skills")}
        />
        </div>
      )}
    </div>
  );
}
