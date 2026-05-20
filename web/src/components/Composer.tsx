import { useEffect, useRef, useState } from "react";
import { Paperclip, SendHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MemePicker } from "./MemePicker";

export function Composer({
  onSend,
  personaName,
}: {
  onSend: (text: string, attachments: File[]) => void;
  personaName: string;
}) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const send = () => {
    const text = value.trim();
    if (!text && attachments.length === 0) return;
    onSend(text, attachments);
    setValue("");
    setAttachments([]);
  };

  const insertMeme = (meme: { name: string; url: string }) => {
    const token = `meme: ${meme.name} (${meme.url})`;
    setValue((prev) => (prev.trim() ? `${prev.trimEnd()}\n${token}` : token));
    window.setTimeout(() => ref.current?.focus(), 0);
  };

  return (
    <div className="border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto max-w-3xl px-5 py-4">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            setAttachments([...(event.target.files ? Array.from(event.target.files) : [])]);
            event.target.value = "";
          }}
        />
        <div className="flex flex-col gap-2 rounded-md border border-input bg-card px-3 py-2.5 shadow-sm transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((file, index) => (
                <button
                  key={`${file.name}-${index}`}
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground"
                >
                  {file.name}
                  <X className="size-3" />
                </button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={ref}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={`write to ${personaName}…`}
              rows={1}
              autoFocus
              className="min-h-8 flex-1 resize-none bg-transparent leading-8 text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <Button type="button" size="sm" variant="ghost" onClick={() => fileRef.current?.click()} aria-label="attach" className="text-muted-foreground hover:text-foreground">
              <Paperclip className="size-4" />
            </Button>
            <MemePicker onPick={insertMeme} />
            <Button
              type="button"
              size="sm"
              onClick={send}
              disabled={!value.trim() && attachments.length === 0}
              aria-label="send"
              className="h-8 px-3"
            >
              <SendHorizontal className="size-4" />
            </Button>
          </div>
        </div>
        <p className="mt-1.5 text-center text-[11px] tracking-wide text-muted-foreground">
          enter to send · shift+enter for newline
        </p>
      </div>
    </div>
  );
}
