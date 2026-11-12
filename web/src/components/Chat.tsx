import { useCallback, useMemo, useState, type RefObject } from "react";
import { Composer, type ComposerHandle } from "./Composer";
import { DiaryShelf } from "./diaries/DiaryShelf";
import { SkillShelf } from "./SkillShelf";
import { Header } from "./Header";
import { KeepBar } from "./KeepBar";
import { MessageList } from "./MessageList";
import { SettingsSurface, type SettingsTabId } from "./SettingsSurface";
import { useChat } from "@/lib/useChat";
import type { WebAuthDevice } from "@/lib/api";

/** the rooms that can be held open beside the talk instead of replacing it */
export type ShelfName = "diaries" | "skills";

export function Chat({
  composer,
  settingsOpen,
  settingsTab,
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
  settingsTab?: SettingsTabId;
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

  // the ends of a stretch being picked out to keep; undefined when nothing is being kept
  const [picked, setPicked] = useState<string[]>();
  const stopKeeping = useCallback(() => setPicked(undefined), []);
  const pick = useCallback((id: string) => setPicked((prev) => (prev && prev.length < 2 ? [...prev, id] : [id])), []);
  const keepRange = useMemo((): [number, number] | undefined => {
    const at = (picked ?? []).map((id) => messages.findIndex((message) => message.id === id)).filter((index) => index >= 0);
    return at.length > 0 ? [Math.min(...at), Math.max(...at)] : undefined;
  }, [picked, messages]);

  // key flips with the mode, so the room remounts on the way in and out — as it did when these were two returns.
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <div
        key={settingsOpen ? "settings" : "chat"}
        className="chat-room room-view flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        data-keeping={picked && !settingsOpen ? "" : undefined}
      >
        {settingsOpen ? (
          <SettingsSurface
            channelKey={activeSessionKey}
            channelLabel={sessions.find((s) => s.key === activeSessionKey)?.label}
            authMode={authMode}
            authDevice={authDevice}
            onSignedOut={onSignedOut}
            initialTab={settingsTab}
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
            onKeep={() => setPicked([])}
            keep={picked ? { range: keepRange, onPick: pick } : undefined}
          />
          {/* the composer stays mounted underneath, so a half-written draft is still there afterwards */}
          <Composer onSend={send} onAbort={abort} streaming={streaming} handle={composer} />
          {picked && (
            <KeepBar
              channelKey={activeSessionKey}
              span={keepRange ? picked : []}
              count={keepRange ? keepRange[1] - keepRange[0] + 1 : 0}
              onDone={stopKeeping}
            />
          )}
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
