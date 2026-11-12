import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Message } from "../types";
import { CallEntry } from "./CallEntry";
import { MessageBubble } from "./MessageBubble";

const GAP_MS = 30 * 60 * 1000;
const SUSPEND_FOLLOW_THRESHOLD_PX = 50;
const RESUME_FOLLOW_THRESHOLD_PX = 10;

function formatGap(ts: number, prevTs: number): string {
  const now = new Date(ts);
  const prev = new Date(prevTs);
  const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  if (now.toDateString() === prev.toDateString()) return time;
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

/** which stretch of the talk is being picked out to keep, and what a tap on a message does */
export interface KeepPicking {
  /** first and last index of the picked span, once something is picked */
  range?: [number, number];
  onPick: (id: string) => void;
}

/** The turns themselves, with no scrolling of their own: the talk draws them, and so does a clipping. */
export function MessageRows({
  messages,
  personaName,
  dated,
  streaming = false,
  pendingLatestAssistantAction,
  onRetry,
  onDelete,
  onEdit,
  onKeep,
  keep,
}: {
  messages: Message[];
  personaName: string;
  /** open with the day and hour of the first turn, as a kept moment does */
  dated?: boolean;
  streaming?: boolean;
  pendingLatestAssistantAction?: "retry" | "delete" | "edit";
  onRetry?: () => void;
  onDelete?: () => void;
  onEdit?: (text: string) => Promise<void>;
  onKeep?: () => void;
  keep?: KeepPicking;
}) {
  const latestAssistantIndex = streaming || keep ? -1 : messages.findLastIndex((message) => message.role === "assistant");
  const last = messages.length - 1;
  return (
    <div className="chat-message-list" data-keeping={keep ? (keep.range ? "picked" : "") : undefined}>
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const showGap = prev != null ? m.ts - prev.ts >= GAP_MS : dated;
        const latest = i === latestAssistantIndex;
        const live = (m.notice === "heartbeat" || m.notice === "cron") && (i === last || (i === last - 1 && streaming));
        const kept = keep?.range && i >= keep.range[0] && i <= keep.range[1];
        return (
          <div
            key={m.id}
            className="chat-turn-group"
            {...(keep && {
              role: "button",
              tabIndex: 0,
              "aria-pressed": !!kept,
              "data-kept": kept ? "" : undefined,
              // the whole turn is the target while picking: nothing inside it answers the tap
              onClickCapture: (event) => {
                event.preventDefault();
                event.stopPropagation();
                keep.onPick(m.id);
              },
              onKeyDown: (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                keep.onPick(m.id);
              },
            })}
          >
            {showGap && <div className="chat-time-divider">{formatGap(m.ts, prev?.ts ?? 0)}</div>}
            {m.call ? (
              <CallEntry call={m.call} ts={m.ts} personaName={personaName} />
            ) : (
              <MessageBubble
                message={m}
                onRetry={latest ? onRetry : undefined}
                onDelete={latest ? onDelete : undefined}
                onEdit={latest ? onEdit : undefined}
                onKeep={latest ? onKeep : undefined}
                pendingLatestAssistantAction={latest ? pendingLatestAssistantAction : undefined}
                live={live}
              />
            )}
          </div>
        );
      })}
    </div>
  );
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
  onKeep,
  keep,
}: {
  messages: Message[];
  personaName: string;
  historyLoaded: boolean;
  streaming?: boolean;
  pendingLatestAssistantAction?: "retry" | "delete" | "edit";
  onRetry?: () => void;
  onDelete?: () => void;
  onEdit?: (text: string) => Promise<void>;
  /** starts picking out a stretch to keep */
  onKeep?: () => void;
  keep?: KeepPicking;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingEndRef = useRef(true);
  const lastMessageIdRef = useRef<string | undefined>(undefined);
  const lastScrollTopRef = useRef(0);
  const lastClientHeightRef = useRef(0);
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
      <div ref={contentRef}>
        <MessageRows
          messages={messages}
          personaName={personaName}
          streaming={streaming}
          pendingLatestAssistantAction={pendingLatestAssistantAction}
          onRetry={onRetry}
          onDelete={onDelete}
          onEdit={onEdit}
          onKeep={onKeep}
          keep={keep}
        />
      </div>
    </div>
  );
}
