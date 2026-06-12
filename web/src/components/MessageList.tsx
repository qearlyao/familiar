import { useEffect, useRef } from "react";
import type { Message } from "../types";
import { MessageBubble } from "./MessageBubble";

const GAP_MS = 30 * 60 * 1000;

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatGap(ts: number, prevTs: number): string {
  const now = new Date(ts);
  const prev = new Date(prevTs);
  const time = now
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase();
  if (isSameDay(now, prev)) return time;
  const today = new Date();
  const sameYear = now.getFullYear() === today.getFullYear();
  const datePart = now
    .toLocaleDateString([], {
      weekday: "long",
      month: sameYear ? "long" : "short",
      day: "numeric",
      year: sameYear ? undefined : "numeric",
    })
    .toLowerCase();
  return `${datePart} · ${time}`;
}

export function MessageList({
  messages,
  personaName,
  historyLoaded,
  streaming = false,
  onRetry,
  onDelete,
}: {
  messages: Message[];
  personaName: string;
  historyLoaded: boolean;
  streaming?: boolean;
  onRetry?: () => void;
  onDelete?: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const latestAssistantIndex = streaming
    ? -1
    : messages.findLastIndex((message) => message.role === "assistant");

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: streaming ? "auto" : "smooth", block: "end" });
  }, [messages, streaming]);

  if (historyLoaded && messages.length === 0) {
    return (
      <div className="mx-auto flex h-full w-full max-w-3xl items-center justify-center px-5 low-dpr-wide:max-w-[clamp(48rem,52vw,72rem)]">
        <p className="font-serif text-base italic leading-relaxed text-muted-foreground/80">
          hi, i'm {personaName}. write whenever.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-12 px-5 py-6 low-dpr-wide:max-w-[clamp(48rem,52vw,72rem)]">
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const showGap = prev != null && m.ts - prev.ts >= GAP_MS;
        return (
          <div key={m.id} className="flex flex-col gap-5">
            {showGap && (
              <div className="flex justify-center pt-2">
                <span className="font-serif italic text-xs text-muted-foreground/70 tracking-wide">
                  {formatGap(m.ts, prev.ts)}
                </span>
              </div>
            )}
            <MessageBubble
              message={m}
              onRetry={i === latestAssistantIndex ? onRetry : undefined}
              onDelete={i === latestAssistantIndex ? onDelete : undefined}
            />
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
