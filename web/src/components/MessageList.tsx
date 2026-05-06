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

export function MessageList({ messages }: { messages: Message[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-5 py-6">
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
            <MessageBubble message={m} />
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
