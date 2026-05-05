import { useEffect, useRef, useState } from "react";
import { SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Composer({ onSend }: { onSend: (text: string) => void }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const send = () => {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue("");
  };

  return (
    <div className="border-t border-border bg-background">
      <div className="mx-auto max-w-3xl px-5 py-4">
        <div className="flex items-end gap-2 rounded-md border border-input bg-card px-3 py-2.5 shadow-sm transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
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
            placeholder="message Familiar…"
            rows={1}
            autoFocus
            className="flex-1 resize-none bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <Button
            type="button"
            size="sm"
            onClick={send}
            disabled={!value.trim()}
            aria-label="send"
            className="h-8 px-3"
          >
            <SendHorizontal className="size-4" />
          </Button>
        </div>
        <p className="mt-1.5 text-center text-[11px] tracking-wide text-muted-foreground">
          enter to send · shift+enter for newline
        </p>
      </div>
    </div>
  );
}
