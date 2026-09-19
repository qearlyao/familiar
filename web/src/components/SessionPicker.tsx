import { useState } from "react";
import { Dialog, Popover } from "radix-ui";
import { fetchSessions, startNewChat, type SessionInfo } from "@/lib/api";
import { contextSegments, type ContextBreakdown } from "@/lib/contextBreakdown";
import { focusPanel } from "@/lib/focusPanel";
import { Sheet } from "./Sheet";
import { cn } from "@/lib/utils";
import { IconChevronDown, IconCheck, IconList, IconPlus, IconX } from "./organicIcons";

function sessionLabel(s: SessionInfo): string {
  if (s.label) return s.label.toLowerCase();
  if (s.scope === "dm") return "main chat";
  return s.channelName ?? s.channelId;
}

const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

export function ContextRing({ tokens, limit, breakdown }: { tokens: number; limit: number; breakdown?: ContextBreakdown }) {
  const fraction = Math.min(tokens / Math.max(limit, 1), 1);
  const percent = Math.round(fraction * 100);
  const free = Math.max(limit - tokens, 0);
  const segments = contextSegments(tokens, breakdown);
  const span = Math.max(tokens, limit, 1);
  const ringScale = RING_C / span;
  return (
    <Popover.Root>
      <Popover.Trigger className="ring-button" title={`context · ${percent}% used`} aria-label={`context · ${percent}% used`}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r={RING_R} fill="none" stroke="rgba(76,62,44,.25)" strokeWidth="3.25" />
          {segments.length > 0 ? segments.filter((segment) => segment.tokens > 0).map((segment) => (
            <circle key={segment.key} cx="12" cy="12" r={RING_R} fill="none"
              stroke={segment.color} strokeWidth="3.25"
              strokeDasharray={`${segment.tokens * ringScale} ${RING_C}`}
              strokeDashoffset={-segment.start * ringScale} />
          )) : <circle
            cx="12"
            cy="12"
            r={RING_R}
            fill="none"
            stroke={fraction >= 0.85 ? "#A85B2A" : "#2B1901"}
            strokeWidth="3.25"
            strokeLinecap="round"
            strokeDasharray={`${RING_C * fraction} ${RING_C}`}
          />}
        </svg>
        <span>{percent}%</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="chat-theme ring-popover" align="end" sideOffset={10} collisionPadding={12} onOpenAutoFocus={focusPanel}>
          <span className="ring-popover-label">context window</span>
          <span className="ring-popover-total">
            {tokens.toLocaleString()} / {limit.toLocaleString()}
          </span>
          <div className="ring-popover-bar">
            {segments.length > 0 ? segments.map((segment) => (
              <span key={segment.key} style={{ width: `${segment.tokens / span * 100}%`, background: segment.color }} />
            )) : <span style={{ width: `${percent}%` }} />}
          </div>
          <span className="ring-popover-note">latest model usage{segments.length > 0 ? " · breakdown approximate" : " · breakdown unavailable"}</span>
          {segments.map((segment) => (
            <div className="ring-popover-row" key={segment.key}>
              <span><i style={{ background: segment.color }} />{segment.label}</span>
              <b>≈{segment.tokens.toLocaleString()}</b>
            </div>
          ))}
          <div className="ring-popover-row">
            <span>free</span>
            <b>{free.toLocaleString()}</b>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Mock 5a/6a: a picker, not a second library — the threads themselves, the one you're in marked,
    each row carrying the last thing said so you recognise a thread by its voice. Desktop drops it
    from the header; a phone raises it as a sheet over the dimmed chat. */

function when(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return new Date(ts).toLocaleDateString(undefined, { weekday: "long" }).toLowerCase();
  if (days < 365) return new Date(ts).toLocaleDateString(undefined, { month: "long" }).toLowerCase();
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric" });
}

/** The header ring reduced to its arc — the row is already a control, so this stays inert. */
function RingArc({ tokens, limit }: { tokens: number; limit: number }) {
  const fraction = Math.min(tokens / Math.max(limit, 1), 1);
  return (
    <svg className="thread-ring" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r={RING_R} fill="none" stroke="rgba(76,62,44,.28)" strokeWidth="4" />
      <circle cx="12" cy="12" r={RING_R} fill="none" stroke="#525833" strokeWidth="4" strokeLinecap="round"
        strokeDasharray={`${RING_C * fraction} ${RING_C}`} />
    </svg>
  );
}

function ThreadRows({ sessions, activeKey, onSelect }: {
  sessions: SessionInfo[];
  activeKey: string | undefined;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="threads-list">
      {sessions.map((s) => {
        const here = s.key === activeKey;
        const label = sessionLabel(s);
        // The one you're in isn't tappable — you're already there.
        const Row = here ? "div" : "button";
        return (
          <Row
            key={s.key}
            className={cn("thread-row", here && "is-here")}
            {...(here ? {} : { type: "button" as const, onClick: () => onSelect(s.key) })}
          >
            <span className="thread-line">
              <b>{label}</b>
              {here ? (
                <em><IconCheck size={13} /> here now</em>
              ) : (
                <em>{s.last ? when(s.last.ts) : "not opened yet"}</em>
              )}
            </span>
            {s.last && <p>{s.last.text}</p>}
            {here && s.context && (
              <span className="thread-held">
                <RingArc tokens={s.context.tokens} limit={s.context.limit} />
                {Math.round((s.context.tokens / Math.max(s.context.limit, 1)) * 100)}% of what they can hold
              </span>
            )}
          </Row>
        );
      })}
    </div>
  );
}

/** Two triggers, one at a time: the header-right pill on desktop (6a), the chevron under their name
    on a phone (5a). Header picks which by width and mounts that one. */
export function SessionPicker({ sessions, activeKey, onSelect, onNewChat, desktop }: {
  sessions: SessionInfo[];
  activeKey: string | undefined;
  onSelect: (key: string) => void;
  /** the thread starts over: `/new` on the session you're already in, not a second one */
  onNewChat: () => void;
  desktop: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [asking, setAsking] = useState(false);
  // ponytail: refetch on open so the last lines and rings are fresh; props show until it lands
  const [fresh, setFresh] = useState<SessionInfo[] | null>(null);
  const list = fresh ?? sessions;
  const active = sessions.find((s) => s.key === activeKey);

  function onOpenChange(next: boolean) {
    setOpen(next);
    setAsking(false);
    if (!next) return;
    setFresh(null);
    fetchSessions().then(setFresh).catch((error: unknown) => console.error("[sessions] refresh failed", error));
  }

  const pick = (key: string) => { onSelect(key); setOpen(false); };

  async function startFresh() {
    if (!activeKey || starting) return;
    setStarting(true);
    try {
      await startNewChat(activeKey);
      onNewChat();
      setOpen(false);
    } catch (error) {
      console.error("[sessions] new chat failed", error);
    } finally {
      setStarting(false);
    }
  }

  const foot = (
    <div className="threads-foot">
      {asking ? (
        <>
          <p className="threads-warn">this clears their context. the talk stays up here — they just won't remember it.</p>
          <div className="threads-ask">
            <button type="button" className="threads-new" disabled={starting} onClick={() => void startFresh()}>
              {starting ? "starting…" : "start fresh"}
            </button>
            <button type="button" className="threads-nevermind" disabled={starting} onClick={() => setAsking(false)}>
              never mind
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="threads-new" disabled={!activeKey} onClick={() => setAsking(true)}>
          <IconPlus />
          start a new chat
        </button>
      )}
    </div>
  );
  const label = active ? sessionLabel(active) : "main chat";
  if (desktop) {
    return (
      <Popover.Root open={open} onOpenChange={onOpenChange}>
        <Popover.Trigger className="session-pill-trigger" aria-label="switch session">
          <IconList size={15} />
          <span>{label}</span>
          <IconChevronDown size={13} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="chat-theme threads"
            align="end"
            sideOffset={10}
            collisionPadding={12}
            onOpenAutoFocus={focusPanel}
          >
            <header className="threads-head">
              <b>your threads</b>
              <span>{list.length} with them · one at a time</span>
            </header>
            <ThreadRows sessions={list} activeKey={activeKey} onSelect={pick} />
            {foot}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} className="threads"
      trigger={<Dialog.Trigger className="session-trigger" aria-label="switch session"><span>{label}</span><IconChevronDown size={12} /></Dialog.Trigger>}>
      <span className="threads-grab" aria-hidden="true" />
      <header className="threads-head">
        <Dialog.Title asChild><b>your threads</b></Dialog.Title>
        <span>{list.length} with them · one at a time</span>
        <Dialog.Close className="threads-close" aria-label="close"><IconX size={16} /></Dialog.Close>
      </header>
      <ThreadRows sessions={list} activeKey={activeKey} onSelect={pick} />
      {foot}
    </Sheet>
  );
}
