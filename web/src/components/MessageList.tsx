import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Message } from "../types";
import { MessageBubble } from "./MessageBubble";

const GAP_MS = 30 * 60 * 1000;
const SUSPEND_FOLLOW_THRESHOLD_PX = 50;
const RESUME_FOLLOW_THRESHOLD_PX = 10;

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatGap(ts: number, prevTs: number): string {
  const now = new Date(ts);
  const prev = new Date(prevTs);
  const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
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
  pendingLatestAssistantAction,
  onRetry,
  onDelete,
  onEdit,
}: {
  messages: Message[];
  personaName: string;
  historyLoaded: boolean;
  streaming?: boolean;
  pendingLatestAssistantAction?: "retry" | "delete" | "edit";
  onRetry?: () => void;
  onDelete?: () => void;
  onEdit?: (text: string) => Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingEndRef = useRef(true);
  const lastMessageIdRef = useRef<string | undefined>(undefined);
  const lastScrollTopRef = useRef(0);
  const lastClientHeightRef = useRef(0);
  const latestAssistantIndex = streaming ? -1 : messages.findLastIndex((message) => message.role === "assistant");
  const lastMessage = messages.at(-1);

  const scrollToEnd = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    followingEndRef.current = true;
    scroll.scrollTop = scroll.scrollHeight;
    lastScrollTopRef.current = scroll.scrollTop;
    lastClientHeightRef.current = scroll.clientHeight;
  }, []);

  useLayoutEffect(() => {
    const previousMessageId = lastMessageIdRef.current;
    const nextMessageId = lastMessage?.id;
    lastMessageIdRef.current = nextMessageId;
    if (!historyLoaded || !nextMessageId || nextMessageId === previousMessageId) return;
    if (lastMessage.role === "user" || followingEndRef.current) scrollToEnd();
  }, [historyLoaded, lastMessage?.id, lastMessage?.role, scrollToEnd]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (followingEndRef.current) scrollToEnd();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToEnd]);

  if (historyLoaded && messages.length === 0) {
    return (
      <div className="chat-empty">
        <div className="chat-empty-note">
          <span className="chat-empty-name">{personaName}</span>
          <p>there’s room for whatever’s on your mind.</p>
          <span className="chat-empty-hint">write whenever.</span>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="chat-scroll"
      onScroll={(event) => {
        const scroll = event.currentTarget;
        const previousScrollTop = lastScrollTopRef.current;
        const previousClientHeight = lastClientHeightRef.current;
        const distanceFromEnd = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
        if (scroll.clientHeight >= previousClientHeight) {
          if (scroll.scrollTop !== 0 && scroll.scrollTop < previousScrollTop && distanceFromEnd > SUSPEND_FOLLOW_THRESHOLD_PX) {
            followingEndRef.current = false;
          } else if (distanceFromEnd < RESUME_FOLLOW_THRESHOLD_PX) {
            followingEndRef.current = true;
          }
        }
        lastScrollTopRef.current = scroll.scrollTop;
        lastClientHeightRef.current = scroll.clientHeight;
      }}
    >
      <div ref={contentRef} className="chat-message-list">
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const showGap = prev != null && m.ts - prev.ts >= GAP_MS;
          const latest = i === latestAssistantIndex;
          return (
            <div key={m.id} className="chat-turn-group">
              {showGap && <div className="chat-time-divider">{formatGap(m.ts, prev.ts)}</div>}
              <MessageBubble
                message={m}
                onRetry={latest ? onRetry : undefined}
                onDelete={latest ? onDelete : undefined}
                onEdit={latest ? onEdit : undefined}
                pendingLatestAssistantAction={latest ? pendingLatestAssistantAction : undefined}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
