import { useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { DraftEditor } from "@/components/DraftEditor";
import { SlashCommandMenu } from "@/components/SlashCommandMenu";
import { VoiceRecordingBar } from "@/components/VoiceRecordingStatus";
import { useVoiceRecorder } from "@/lib/useVoiceRecorder";
import type { DraftBlock } from "@/lib/composerDraft";
import { appendDraftText, composerSendDisabled, emptyDraftBlocks, hasDraftBlocksContent, serializeDraftBlocks } from "@/lib/composerDraft";
import {
  controlCommandCompletionQuery,
  matchingControlCommands,
  parseControlCommandText,
  type ControlCommandDefinition,
} from "@/lib/slashCommands";
import { cn } from "@/lib/utils";
import { IconArrow, IconMic, IconPaperclip, IconSticker, IconStop, IconX } from "./organicIcons";

type Draft = {
  blocks: DraftBlock[];
  attachments: File[];
  revision: number;
};

function emptyDraft(revision = 0): Draft {
  return { blocks: emptyDraftBlocks(), attachments: [], revision };
}

function sendErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "send failed";
  const normalized = message ? `${message.charAt(0).toLowerCase()}${message.slice(1)}` : "send failed";
  return normalized.startsWith("send failed") ? normalized : `send failed: ${normalized}`;
}

function isClearedDraft(draft: Draft, revision: number): boolean {
  return draft.revision === revision && !hasDraftBlocksContent(draft.blocks) && draft.attachments.length === 0;
}

function singleTextBlock(blocks: DraftBlock[]): string | undefined {
  return blocks.length === 1 && blocks[0]?.type === "text" ? blocks[0].value : undefined;
}

function slashCommandText(command: ControlCommandDefinition): string {
  return `/${command.name}${command.argumentLabel ? " " : ""}`;
}


export interface ComposerHandle {
  append: (text: string) => void;
}

export function Composer({
  onSend,
  onAbort,
  streaming,
  handle,
}: {
  onSend: (text: string, attachments: File[]) => Promise<void>;
  onAbort: () => void;
  streaming: boolean;
  /** lets another surface (the diaries shelf) drop text into the draft */
  handle?: RefObject<ComposerHandle | null>;
}) {
  const [draft, setDraft] = useState<Draft>(() => emptyDraft());
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [commandSelection, setCommandSelection] = useState<{ text: string | undefined; index: number }>({ text: undefined, index: 0 });
  const [dismissedCommandText, setDismissedCommandText] = useState<string | undefined>();
  const fileRef = useRef<HTMLInputElement>(null);
  const voice = useVoiceRecorder({ onAttach: (files) => addAttachments(files), onError: setError });
  const { blocks, attachments } = draft;
  const serializedText = useMemo(() => serializeDraftBlocks(blocks), [blocks]);
  const commandDraftText = singleTextBlock(blocks);
  const commandSuggestions = useMemo(
    () => (attachments.length === 0 && commandDraftText !== undefined ? matchingControlCommands(commandDraftText) : []),
    [attachments.length, commandDraftText],
  );
  const commandMenuOpen =
    commandSuggestions.length > 0 &&
    commandDraftText !== undefined &&
    dismissedCommandText !== commandDraftText &&
    controlCommandCompletionQuery(commandDraftText) !== undefined;
  const exactCommandDraft = !!commandDraftText && !!parseControlCommandText(commandDraftText);
  const selectedCommandIndex =
    commandDraftText === undefined
      ? 0
      : Math.min(commandSelection.text === commandDraftText ? commandSelection.index : 0, Math.max(0, commandSuggestions.length - 1));

  const send = async () => {
    if (sending || voice.pending) return;
    const submitted = draft;
    const text = serializeDraftBlocks(submitted.blocks);
    if (!text && submitted.attachments.length === 0) return;
    const clearedRevision = submitted.revision + 1;
    setError(undefined);
    setSending(true);
    setDraft((d) => emptyDraft(d.revision + 1));
    try {
      await onSend(text, submitted.attachments);
    } catch (err) {
      setDraft((current) => (isClearedDraft(current, clearedRevision) ? submitted : current));
      setError(sendErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const updateBlocks = (update: (blocks: DraftBlock[]) => DraftBlock[]) => {
    setError(undefined);
    setDraft((prev) => {
      const next = update(prev.blocks);
      return next === prev.blocks ? prev : { ...prev, blocks: next, revision: prev.revision + 1 };
    });
  };

  useImperativeHandle(handle, () => ({ append: (text: string) => updateBlocks((blocks) => appendDraftText(blocks, text)) }));

  const applyCommandSuggestion = (command: ControlCommandDefinition) => {
    const nextText = slashCommandText(command);
    setDismissedCommandText(undefined);
    setCommandSelection({ text: nextText, index: 0 });
    setDraft((prev) => ({ ...prev, blocks: [{ type: "text", value: nextText }], revision: prev.revision + 1 }));
  };

  const handleCommandKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!commandMenuOpen || commandDraftText === undefined) return false;
    const pick = () => {
      const command = commandSuggestions[selectedCommandIndex] ?? commandSuggestions[0];
      if (command) applyCommandSuggestion(command);
    };
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCommandSelection({ text: commandDraftText, index: (selectedCommandIndex + 1) % commandSuggestions.length });
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCommandSelection({ text: commandDraftText, index: (selectedCommandIndex - 1 + commandSuggestions.length) % commandSuggestions.length });
      return true;
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !exactCommandDraft)) {
      event.preventDefault();
      pick();
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissedCommandText(commandDraftText);
      return true;
    }
    return false;
  };

  const addAttachments = (files: File[]) => {
    if (files.length === 0) return;
    setError(undefined);
    setDraft((prev) => ({ ...prev, attachments: [...prev.attachments, ...files], revision: prev.revision + 1 }));
  };

  const removeAttachment = (index: number) => {
    setError(undefined);
    setDraft((prev) => ({ ...prev, attachments: prev.attachments.filter((_, i) => i !== index), revision: prev.revision + 1 }));
  };

  const droppedFiles = (items: DataTransferItemList, fallback: FileList): File[] => {
    const files = Array.from(items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    return files.length > 0 ? files : Array.from(fallback);
  };

  const showAbort = streaming && !sending;
  const voiceBusy = voice.pending || voice.recording;
  const sendDisabled = composerSendDisabled({ showAbort, sending, voiceBusy, hasText: !!serializedText, hasAttachments: attachments.length > 0 });

  return (
    <div className="composer">
      <div className="composer-veil" aria-hidden><i /><i /><i /><i /></div>
      <div className="composer-inner">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            addAttachments(event.target.files ? Array.from(event.target.files) : []);
            event.target.value = "";
          }}
        />
        {commandMenuOpen && <SlashCommandMenu commands={commandSuggestions} selectedIndex={selectedCommandIndex} onSelect={applyCommandSuggestion} />}
        {voice.recording ? (
          <div className="composer-box is-recording">
            <VoiceRecordingBar />
            <button type="button" className="composer-rec-cancel" aria-label="let it go" title="let it go" onClick={voice.cancelRecording}>
              <IconX />
            </button>
            <button type="button" className="composer-rec-stop" aria-label="stop and attach" title="stop and attach" onClick={voice.toggleRecording}>
              <IconStop />
            </button>
          </div>
        ) : (
          <div
            onDragEnter={(event) => {
              if (event.dataTransfer.types.includes("Files")) {
                event.preventDefault();
                setDragging(true);
              }
            }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) event.preventDefault();
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              addAttachments(droppedFiles(event.dataTransfer.items, event.dataTransfer.files));
            }}
            className={cn("composer-box", dragging && "is-dragging", (commandMenuOpen || exactCommandDraft) && "is-command", (serializedText || attachments.length > 0) && "has-text", (showAbort || sending) && "is-busy")}
          >
            <DraftEditor
              blocks={blocks}
              attachments={attachments}
              onRemoveAttachment={removeAttachment}
              onUpdateBlocks={updateBlocks}
              onPasteFiles={addAttachments}
              onSubmit={() => void send()}
              onCommandKeyDown={handleCommandKeyDown}
              stickersOpen={stickersOpen}
              onStickersOpenChange={setStickersOpen}
            />
            <div className="composer-right">
              <button type="button" className={cn("composer-icon composer-stickers-btn", stickersOpen && "is-filled")} aria-label="stickers" title="stickers" aria-expanded={stickersOpen} onClick={() => setStickersOpen((v) => !v)}>
                <IconSticker />
              </button>
              <button type="button" className="composer-icon composer-attach-btn" aria-label="attach" title="bring something in" disabled={sending} onClick={() => fileRef.current?.click()}>
                <IconPaperclip viewBox="-1 -1 26 26" />
              </button>
              <button type="button" className="composer-icon composer-mic-btn" aria-label="record a voice message" title="speak it" disabled={sending || voice.pending} onClick={voice.toggleRecording}>
                <IconMic />
              </button>
              <button
                type="button"
                className="composer-send"
                onClick={showAbort ? onAbort : () => void send()}
                disabled={sendDisabled}
                aria-label={showAbort ? "stop" : "say it"}
                title={showAbort ? "stop the reply" : "say it"}
              >
                {showAbort ? (
                  <IconStop size={16} />
                ) : (
                  <>
                    <span className="label">say it</span>
                    <IconArrow />
                  </>
                )}
              </button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="composer-error">
            {error}
          </p>
        )}
        <p className="composer-hint">
          {voice.recording
            ? "tap the square to send · × to let it go"
            : window.matchMedia("(pointer: coarse)").matches
              ? "tap the arrow to send · type / to call a small tool"
              : "enter sends · shift + enter for a new line · type / to call a small tool"}
        </p>
      </div>
    </div>
  );
}
