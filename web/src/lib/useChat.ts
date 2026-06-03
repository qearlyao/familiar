import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, Step, ThinkingStep, ToolEvent, ToolStep, TextStep } from "../types";
import {
  fetchAuthMode,
  fetchHistory,
  fetchSessions,
  sendMessage as sendMessageApi,
  streamUrl,
  type ConnectionState,
  type SessionInfo,
  type StreamEvent,
} from "./api";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function mergeTool(existing: ToolEvent | undefined, patch: ToolEvent): ToolEvent {
  const terminal = patch.status === "completed" || patch.status === "error";
  return {
    ...existing,
    ...patch,
    args: patch.args ?? existing?.args,
    partialResult: terminal ? undefined : (patch.partialResult ?? existing?.partialResult),
    result: patch.result ?? existing?.result,
    error: patch.error ?? existing?.error,
    startedAt: existing?.startedAt ?? patch.startedAt,
  };
}

function closeContentSteps(steps: Step[], now: number): Step[] {
  if (steps.length === 0) return steps;
  return steps.map((step) => {
    if (step.kind === "thinking") {
      if (step.complete) return step;
      return { ...step, complete: true, endedAt: step.endedAt ?? now };
    }
    if (step.kind === "text") {
      if (step.complete) return step;
      return { ...step, complete: true };
    }
    return step;
  });
}

function appendDelta(
  steps: Step[],
  part: "thinking" | "text",
  content: string,
  now: number,
): Step[] {
  const last = steps[steps.length - 1];
  if (part === "thinking") {
    if (last && last.kind === "thinking" && !last.complete) {
      const updated: ThinkingStep = { ...last, text: last.text + content };
      return [...steps.slice(0, -1), updated];
    }
    const closed = closeContentSteps(steps, now);
    const next: ThinkingStep = {
      kind: "thinking",
      id: uid(),
      text: content,
      startedAt: now,
    };
    return [...closed, next];
  }
  if (last && last.kind === "text" && !last.complete) {
    const updated: TextStep = { ...last, text: last.text + content };
    return [...steps.slice(0, -1), updated];
  }
  const closed = closeContentSteps(steps, now);
  const next: TextStep = { kind: "text", id: uid(), text: content };
  return [...closed, next];
}

function upsertToolStep(steps: Step[], tool: ToolEvent, now: number): Step[] {
  const idx = steps.findIndex((s) => s.kind === "tool" && s.tool.id === tool.id);
  if (idx >= 0) {
    const existing = steps[idx] as ToolStep;
    const merged: ToolStep = { ...existing, tool: mergeTool(existing.tool, tool) };
    const next = steps.slice();
    next[idx] = merged;
    return next;
  }
  const closed = closeContentSteps(steps, now);
  const next: ToolStep = { kind: "tool", id: tool.id, tool };
  return [...closed, next];
}

export interface ChatHook {
  messages: Message[];
  connection: ConnectionState;
  personaName: string;
  sessions: SessionInfo[];
  activeSessionKey: string | undefined;
  historyLoaded: boolean;
  streaming: boolean;
  selectSession: (key: string) => void;
  send: (text: string, attachments?: File[]) => Promise<void>;
  abort: () => void;
  retry: () => void;
  deleteLatest: () => void;
  notifyNewChat: () => void;
}

export function useChat(): ChatHook {
  const [messages, setMessages] = useState<Message[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [personaName, setPersonaName] = useState<string>("Familiar");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionKey, setActiveSessionKey] = useState<string | undefined>(undefined);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [streaming, setStreaming] = useState(false);

  const lastEventIdRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sendRef = useRef<(text: string, attachments?: File[]) => Promise<void>>(async () => undefined);

  const patchSteps = useCallback((messageId: string, fn: (steps: Step[]) => Step[]) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, steps: fn(m.steps) } : m)));
  }, []);

  const handleEvent = useCallback(
    (event: StreamEvent) => {
      if ("eventId" in event) lastEventIdRef.current = event.eventId;

      switch (event.type) {
        case "message_started": {
          if (event.role !== "user") setStreaming(true);
          setMessages((prev) => {
            if (prev.some((m) => m.id === event.messageId)) return prev;
            return [
              ...prev,
              {
                id: event.messageId,
                role: event.role,
                who: event.who,
                steps: [],
                ts: event.ts,
              },
            ];
          });
          break;
        }

        case "message_replaced": {
          setStreaming(true);
          setMessages((prev) => prev.filter((m) => m.id !== event.oldMessageId));
          break;
        }

        case "message_deleted": {
          setMessages((prev) => prev.filter((m) => m.id !== event.messageId));
          break;
        }

        case "delta": {
          const now = Date.now();
          patchSteps(event.messageId, (steps) => appendDelta(steps, event.part, event.content, now));
          break;
        }

        case "tool_event": {
          const now = Date.now();
          patchSteps(event.messageId, (steps) => upsertToolStep(steps, event.tool, now));
          break;
        }

        case "message_completed": {
          const now = Date.now();
          setMessages((prev) => {
            const existing = prev.find((m) => m.id === event.messageId);
            if (!existing) {
              return [
                ...prev,
                {
                  id: event.messageId,
                  role: "assistant",
                  who: personaName,
                  steps: [],
                  attachments: event.attachments,
                  usage: event.usage,
                  silent: event.silent,
                  ts: event.ts,
                },
              ];
            }
            return prev.map((m) => {
              if (m.id !== event.messageId) return m;
              return {
                ...m,
                steps: closeContentSteps(m.steps, now),
                attachments: event.attachments ?? m.attachments,
                usage: event.usage ?? m.usage,
                silent: event.silent ?? m.silent,
              };
            });
          });
          break;
        }

        case "model_error": {
          const now = Date.now();
          const errorStepId = `${event.messageId}-error`;
          setMessages((prev) => {
            const errorStep: Step = { kind: "error", id: errorStepId, text: event.message };
            const existing = prev.find((m) => m.id === event.messageId);
            if (!existing) {
              return [
                ...prev,
                { id: event.messageId, role: "assistant", who: personaName, steps: [errorStep], ts: event.ts },
              ];
            }
            return prev.map((m) => {
              if (m.id !== event.messageId) return m;
              if (m.steps.some((s) => s.id === errorStepId)) {
                return { ...m, steps: m.steps.map((s) => (s.id === errorStepId ? errorStep : s)) };
              }
              return { ...m, steps: [...closeContentSteps(m.steps, now), errorStep] };
            });
          });
          break;
        }

        case "status": {
          if (event.kind === "idle") setStreaming(false);
          break;
        }

        case "error": {
          setStreaming(false);
          setMessages((prev) => [
            ...prev,
            {
              id: uid(),
              role: "system",
              who: "",
              steps: [
                {
                  kind: "text",
                  id: uid(),
                  text: `error · ${event.code}: ${event.message}`,
                  complete: true,
                },
              ],
              ts: event.ts,
            },
          ]);
          break;
        }

        case "replay_window_lost": {
          fetchHistory(activeSessionKey)
            .then((res) => setMessages(res.messages))
            .catch(() => undefined);
          break;
        }
      }
    },
    [activeSessionKey, personaName, patchSteps],
  );

  const handleEventRef = useRef(handleEvent);
  useEffect(() => {
    handleEventRef.current = handleEvent;
  }, [handleEvent]);

  useEffect(() => {
    let cancelled = false;
    fetchAuthMode()
      .then((info) => {
        if (!cancelled) setPersonaName(info.personaName);
      })
      .catch(() => undefined);

    fetchSessions()
      .then((list) => {
        if (cancelled) return;
        setSessions(list);
        const stored = localStorage.getItem("familiar.activeSession");
        const fromStored = stored ? list.find((s) => s.key === stored) : undefined;
        const def = list.find((s) => s.isDefault) ?? list[0];
        const chosen = (fromStored ?? def)?.key;
        if (chosen) setActiveSessionKey(chosen);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeSessionKey) return;
    localStorage.setItem("familiar.activeSession", activeSessionKey);

    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    lastEventIdRef.current = null;

    const resetTimer = window.setTimeout(() => {
      if (cancelled) return;
      setMessages([]);
      setHistoryLoaded(false);
      setStreaming(false);
    }, 0);

    fetchHistory(activeSessionKey)
      .then((res) => {
        if (!cancelled) {
          setMessages(res.messages);
          setHistoryLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setHistoryLoaded(true);
      });

    const connect = () => {
      if (cancelled) return;
      setConnection("connecting");
      const socket = new WebSocket(streamUrl(activeSessionKey));
      ws = socket;
      wsRef.current = socket;

      socket.addEventListener("open", () => {
        if (cancelled) return;
        reconnectAttempts = 0;
        setConnection("open");
        socket.send(JSON.stringify({ type: "hello", lastEventId: lastEventIdRef.current }));
      });

      socket.addEventListener("message", (e) => {
        if (cancelled) return;
        try {
          const data = JSON.parse(e.data) as StreamEvent;
          handleEventRef.current(data);
        } catch {
          /* ignore malformed frame */
        }
      });

      socket.addEventListener("close", () => {
        if (cancelled) return;
        if (wsRef.current === socket) wsRef.current = null;
        setConnection("closed");
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts);
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(connect, delay);
      });

      socket.addEventListener("error", () => {
        if (cancelled) return;
        setConnection("error");
      });
    };

    connect();

    sendRef.current = async (text: string, attachments: File[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      await sendMessageApi(trimmed, uid(), activeSessionKey, attachments);
    };

    return () => {
      cancelled = true;
      clearTimeout(resetTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current === ws) wsRef.current = null;
      ws?.close();
    };
  }, [activeSessionKey]);

  const send = useCallback((text: string, attachments: File[] = []) => sendRef.current(text, attachments), []);
  const selectSession = useCallback((key: string) => setActiveSessionKey(key), []);

  const sendControlFrame = useCallback((type: string): boolean => {
    const sock = wsRef.current;
    if (sock?.readyState !== WebSocket.OPEN) return false;
    sock.send(JSON.stringify({ type }));
    return true;
  }, []);

  const abort = useCallback(() => {
    sendControlFrame("abort");
  }, [sendControlFrame]);

  const retry = useCallback(() => {
    sendControlFrame("retry");
  }, [sendControlFrame]);

  const deleteLatest = useCallback(() => {
    sendControlFrame("delete");
  }, [sendControlFrame]);

  const notifyNewChat = useCallback(() => {
    setMessages((prev) => [
      ...prev,
      {
        id: uid(),
        role: "system",
        who: "",
        steps: [
          { kind: "text", id: uid(), text: "started fresh", complete: true },
        ],
        ts: Date.now(),
      },
    ]);
  }, []);

  return {
    messages,
    connection,
    personaName,
    sessions,
    activeSessionKey,
    historyLoaded,
    streaming,
    selectSession,
    send,
    abort,
    retry,
    deleteLatest,
    notifyNewChat,
  };
}
