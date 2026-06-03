import { useEffect, useRef, useState } from "react";
import { Paperclip, SendHorizontal, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MemePicker } from "./MemePicker";

type Draft = {
  value: string;
  attachments: File[];
  revision: number;
};

const EMPTY_DRAFT: Draft = { value: "", attachments: [], revision: 0 };

function sendErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "send failed";
  const normalized = message ? `${message.charAt(0).toLowerCase()}${message.slice(1)}` : "send failed";
  return normalized.startsWith("send failed") ? normalized : `send failed: ${normalized}`;
}

function emptyNextDraft(draft: Draft): Draft {
  return { value: "", attachments: [], revision: draft.revision + 1 };
}

function isClearedDraft(draft: Draft, revision: number): boolean {
  return draft.revision === revision && draft.value.length === 0 && draft.attachments.length === 0;
}

export function Composer({
  onSend,
  onAbort,
  streaming,
  personaName,
}: {
  onSend: (text: string, attachments: File[]) => Promise<void>;
  onAbort: () => void;
  streaming: boolean;
  personaName: string;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { value, attachments } = draft;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const send = async () => {
    if (sending) return;
    const submittedDraft = draft;
    const text = value.trim();
    if (!text && attachments.length === 0) return;
    const clearedRevision = submittedDraft.revision + 1;
    setError(undefined);
    setSending(true);
    setDraft(emptyNextDraft);
    try {
      await onSend(text, submittedDraft.attachments);
    } catch (err) {
      setDraft((current) => (isClearedDraft(current, clearedRevision) ? submittedDraft : current));
      setError(sendErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const insertMeme = (meme: { name: string; url: string }) => {
    const token = `meme: ${meme.name} (${meme.url})`;
    setDraft((prev) => ({
      ...prev,
      value: prev.value.trim() ? `${prev.value.trimEnd()}\n${token}` : token,
      revision: prev.revision + 1,
    }));
    setError(undefined);
    window.setTimeout(() => ref.current?.focus(), 0);
  };

  const addAttachments = (files: File[]) => {
    if (files.length === 0) return;
    setError(undefined);
    setDraft((prev) => ({
      ...prev,
      attachments: [...prev.attachments, ...files],
      revision: prev.revision + 1,
    }));
  };

  const droppedFiles = (items: DataTransferItemList, fallback: FileList): File[] => {
    const files = Array.from(items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    return files.length > 0 ? files : Array.from(fallback);
  };

  const sendDisabled = sending || (!streaming && !value.trim() && attachments.length === 0);
  const showAbort = streaming && !sending;

  return (
    <div className="border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto max-w-3xl px-5 py-4">
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
          className={cn(
            "flex flex-col gap-2 rounded-md border border-input bg-card px-3 py-2.5 shadow-sm transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30",
            dragging && "border-ring ring-3 ring-ring/30",
          )}
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((file, index) => (
                <button
                  key={`${file.name}-${index}`}
                  type="button"
                  onClick={() => {
                    setError(undefined);
                    setDraft((prev) => ({
                      ...prev,
                      attachments: prev.attachments.filter((_, i) => i !== index),
                      revision: prev.revision + 1,
                    }));
                  }}
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground"
                >
                  {file.name}
                  <X className="size-3" />
                </button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => fileRef.current?.click()}
              aria-label="attach"
              className="text-muted-foreground hover:text-foreground"
            >
              <Paperclip className="size-4" />
            </Button>
            <MemePicker onPick={insertMeme} />
            <textarea
              ref={ref}
              value={value}
              onChange={(e) => {
                setError(undefined);
                setDraft((prev) => ({ ...prev, value: e.target.value, revision: prev.revision + 1 }));
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (files.length > 0) addAttachments(files);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={`write to ${personaName}…`}
              rows={1}
              autoFocus
              className="min-h-8 flex-1 resize-none bg-transparent leading-8 text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <Button
              type="button"
              size="sm"
              onClick={showAbort ? onAbort : () => void send()}
              disabled={sendDisabled}
              aria-label={showAbort ? "stop" : "send"}
              className="h-8 px-3"
            >
              {showAbort ? (
                <Square className="size-3 fill-current" strokeWidth={0} />
              ) : (
                <SendHorizontal className="size-4" />
              )}
            </Button>
          </div>
        </div>
        {error ? <p className="mt-1.5 text-center font-serif text-xs italic text-destructive">{error}</p> : null}
        <p className="mt-1.5 text-center text-[11px] tracking-wide text-muted-foreground">
          enter to send · shift+enter for newline
        </p>
      </div>
    </div>
  );
}
