import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, Step, ThinkingStep, ToolEvent, ToolStep, TextStep } from "../types";
import {
  fetchAuthMode,
  fetchHistory,
  fetchSessions,
  sendLatestAssistantAction as sendLatestAssistantActionApi,
  sendControlCommand as sendControlCommandApi,
  sendMessage as sendMessageApi,
  streamUrl,
  type ConnectionState,
  type LatestAssistantAction,
  type SessionInfo,
  type StreamEvent,
  type StreamFrame,
} from "./api";
import { parseControlCommandText } from "./slashCommands";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const STALE_SOCKET_MS = 60_000;
const SEND_RESYNC_DELAY_MS = 1500;

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
  pendingLatestAssistantAction: LatestAssistantAction | undefined;
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
  const [pendingLatestAssistantAction, setPendingLatestAssistantAction] = useState<
    LatestAssistantAction | undefined
  >(undefined);

  const lastEventIdRef = useRef<string | null>(null);
  const lastEventAtRef = useRef<number>(Date.now());
  const messagesRef = useRef<Message[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const sendRef = useRef<(text: string, attachments?: File[]) => Promise<void>>(async () => undefined);
  const dispatchLatestAssistantActionRef = useRef<(action: LatestAssistantAction) => Promise<void>>(
    async () => undefined,
  );
  const activeAssistantMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingLatestAssistantActionRef = useRef<LatestAssistantAction | undefined>(undefined);
  const pendingLatestAssistantMessageIdRef = useRef<string | undefined>(undefined);
  const latestAssistantActionResyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const appendSystemMessage = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: uid(),
        role: "system",
        who: "",
        steps: [{ kind: "text", id: uid(), text, complete: true }],
        ts: Date.now(),
      },
    ]);
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const stopLatestAssistantActionResync = useCallback(() => {
    const timer = latestAssistantActionResyncTimerRef.current;
    if (timer) {
      clearTimeout(timer);
      latestAssistantActionResyncTimerRef.current = null;
    }
  }, []);

  const clearPendingLatestAssistantAction = useCallback(() => {
    stopLatestAssistantActionResync();
    pendingLatestAssistantActionRef.current = undefined;
    pendingLatestAssistantMessageIdRef.current = undefined;
    setPendingLatestAssistantAction(undefined);
  }, [stopLatestAssistantActionResync]);

  const beginPendingLatestAssistantAction = useCallback(
    (action: LatestAssistantAction, messageId: string) => {
      stopLatestAssistantActionResync();
      pendingLatestAssistantActionRef.current = action;
      pendingLatestAssistantMessageIdRef.current = messageId;
      setPendingLatestAssistantAction(action);
    },
    [stopLatestAssistantActionResync],
  );

  const latestAssistantMessageId = useCallback((): string | undefined => {
    for (let i = messagesRef.current.length - 1; i >= 0; i -= 1) {
      const message = messagesRef.current[i];
      if (message.role === "assistant") return message.id;
    }
    return undefined;
  }, []);

  const reconcilePendingLatestAssistantAction = useCallback(
    (nextMessages: Message[]) => {
      const targetMessageId = pendingLatestAssistantMessageIdRef.current;
      if (!pendingLatestAssistantActionRef.current || !targetMessageId) return;
      for (let i = nextMessages.length - 1; i >= 0; i -= 1) {
        const message = nextMessages[i];
        if (message.role !== "assistant") continue;
        if (message.id === targetMessageId) return;
        clearPendingLatestAssistantAction();
        return;
      }
      clearPendingLatestAssistantAction();
    },
    [clearPendingLatestAssistantAction],
  );

  const resolvePendingLatestAssistantAction = useCallback(
    (event: StreamEvent) => {
      const pendingAction = pendingLatestAssistantActionRef.current;
      if (!pendingAction) return;
      const targetMessageId = pendingLatestAssistantMessageIdRef.current;
      switch (event.type) {
        case "message_started":
          if (pendingAction === "retry" && event.role !== "user") {
            clearPendingLatestAssistantAction();
          }
          break;
        case "message_replaced":
          if (pendingAction === "retry" && (!targetMessageId || event.oldMessageId === targetMessageId)) {
            clearPendingLatestAssistantAction();
          }
          break;
        case "message_deleted":
          if (!targetMessageId || event.messageId === targetMessageId) {
            clearPendingLatestAssistantAction();
          }
          break;
        case "message_completed":
        case "model_error":
          if (pendingAction === "retry") {
            clearPendingLatestAssistantAction();
          }
          break;
        case "status":
          if (event.kind === "idle") {
            clearPendingLatestAssistantAction();
          }
          break;
        case "error":
        case "replay_window_lost":
          clearPendingLatestAssistantAction();
          break;
      }
    },
    [clearPendingLatestAssistantAction],
  );

  const patchSteps = useCallback((messageId: string, fn: (steps: Step[]) => Step[]) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, steps: fn(m.steps) } : m)));
  }, []);

  const handleEvent = useCallback(
    (event: StreamEvent) => {
      lastEventAtRef.current = Date.now();
      if ("eventId" in event) lastEventIdRef.current = event.eventId;
      resolvePendingLatestAssistantAction(event);

      switch (event.type) {
        case "message_started": {
          if (event.role !== "user") {
            activeAssistantMessageIdsRef.current.add(event.messageId);
            setStreaming(true);
          }
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
          activeAssistantMessageIdsRef.current.delete(event.oldMessageId);
          activeAssistantMessageIdsRef.current.add(event.newMessageId);
          setStreaming(true);
          setMessages((prev) => prev.filter((m) => m.id !== event.oldMessageId));
          break;
        }

        case "message_deleted": {
          activeAssistantMessageIdsRef.current.delete(event.messageId);
          if (activeAssistantMessageIdsRef.current.size === 0) setStreaming(false);
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
          if (activeAssistantMessageIdsRef.current.delete(event.messageId)) {
            setStreaming(activeAssistantMessageIdsRef.current.size > 0);
          }
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
          if (event.kind === "idle") {
            activeAssistantMessageIdsRef.current.clear();
            setStreaming(false);
          }
          break;
        }

        case "error": {
          activeAssistantMessageIdsRef.current.clear();
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
          lastEventIdRef.current = null;
          activeAssistantMessageIdsRef.current.clear();
          setStreaming(false);
          fetchHistory(activeSessionKey)
            .then((res) => {
              reconcilePendingLatestAssistantAction(res.messages);
              setMessages(res.messages);
              setHistoryLoaded(true);
              lastEventAtRef.current = Date.now();
            })
            .catch(() => undefined);
          break;
        }
      }
    },
    [activeSessionKey, personaName, patchSteps, reconcilePendingLatestAssistantAction, resolvePendingLatestAssistantAction],
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
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let resyncTimer: ReturnType<typeof setTimeout> | null = null;

    lastEventIdRef.current = null;
    activeAssistantMessageIdsRef.current.clear();
    lastEventAtRef.current = Date.now();
    clearPendingLatestAssistantAction();

    const resetTimer = window.setTimeout(() => {
      if (cancelled) return;
      setMessages([]);
      setHistoryLoaded(false);
      setStreaming(false);
    }, 0);

    fetchHistory(activeSessionKey)
      .then((res) => {
        if (!cancelled) {
          reconcilePendingLatestAssistantAction(res.messages);
          setMessages(res.messages);
          setHistoryLoaded(true);
          lastEventAtRef.current = Date.now();
        }
      })
      .catch(() => {
        if (!cancelled) setHistoryLoaded(true);
      });

    const refreshHistory = async (): Promise<void> => {
      const res = await fetchHistory(activeSessionKey);
      if (cancelled) return;
      reconcilePendingLatestAssistantAction(res.messages);
      setMessages(res.messages);
      setHistoryLoaded(true);
      lastEventAtRef.current = Date.now();
    };

    const refreshHistoryQuietly = (): void => {
      void refreshHistory().catch(() => undefined);
    };

    const recoverTransport = (): void => {
      if (cancelled) return;
      if (!lastEventIdRef.current) refreshHistoryQuietly();
      const socket = wsRef.current;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close(4000, "stale");
        return;
      }
    };

    const recoverIfStale = (): void => {
      if (cancelled) return;
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastEventAtRef.current < STALE_SOCKET_MS) return;
      recoverTransport();
    };

    const stopHeartbeat = (): void => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    };

    const scheduleLatestAssistantActionRecovery = (): void => {
      stopLatestAssistantActionResync();
      latestAssistantActionResyncTimerRef.current = window.setTimeout(() => {
        latestAssistantActionResyncTimerRef.current = null;
        if (cancelled || !pendingLatestAssistantActionRef.current) return;
        refreshHistoryQuietly();
        recoverTransport();
      }, SEND_RESYNC_DELAY_MS);
    };

    const sendHeartbeat = (): void => {
      if (cancelled || document.visibilityState !== "visible") return;
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastEventAtRef.current > HEARTBEAT_TIMEOUT_MS) {
        recoverTransport();
        return;
      }
      try {
        socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        recoverTransport();
      }
    };

    const startHeartbeat = (): void => {
      stopHeartbeat();
      heartbeatTimer = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    };

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
        lastEventAtRef.current = Date.now();
        socket.send(JSON.stringify({ type: "hello", lastEventId: lastEventIdRef.current }));
        startHeartbeat();
      });

      socket.addEventListener("message", (e) => {
        if (cancelled) return;
        lastEventAtRef.current = Date.now();
        try {
          const data = JSON.parse(e.data) as StreamFrame;
          if (data.type === "pong") return;
          handleEventRef.current(data);
        } catch {
          /* ignore malformed frame */
        }
      });

      socket.addEventListener("close", () => {
        if (cancelled) return;
        stopHeartbeat();
        if (wsRef.current === socket) wsRef.current = null;
        setConnection("closed");
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts);
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(connect, delay);
      });

      socket.addEventListener("error", () => {
        if (cancelled) return;
        setConnection("error");
        if (wsRef.current === socket && socket.readyState !== WebSocket.CLOSED) {
          socket.close(4000, "error");
        }
      });
    };

    connect();

    const onVisibilityChange = (): void => {
      recoverIfStale();
    };
    const onFocus = (): void => {
      recoverIfStale();
    };
    const onPageShow = (): void => {
      recoverIfStale();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);

    sendRef.current = async (text: string, attachments: File[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      const control = attachments.length === 0 ? parseControlCommandText(trimmed) : undefined;
      if (control) {
        const result = await sendControlCommandApi(control.command, control.args, activeSessionKey);
        appendSystemMessage(result.message);
        return;
      }
      const messageId = uid();
      const result = await sendMessageApi(trimmed, messageId, activeSessionKey, attachments);
      if (resyncTimer) clearTimeout(resyncTimer);
      resyncTimer = window.setTimeout(() => {
        if (cancelled) return;
        if (messagesRef.current.some((message) => message.id === result.id)) return;
        refreshHistoryQuietly();
        recoverTransport();
      }, SEND_RESYNC_DELAY_MS);
    };

    dispatchLatestAssistantActionRef.current = async (action: LatestAssistantAction) => {
      if (!sendControlFrame(action)) {
        await sendLatestAssistantActionApi(action, activeSessionKey);
      }
      scheduleLatestAssistantActionRecovery();
    };

    return () => {
      cancelled = true;
      clearTimeout(resetTimer);
      if (resyncTimer) clearTimeout(resyncTimer);
      stopLatestAssistantActionResync();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopHeartbeat();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      if (wsRef.current === ws) wsRef.current = null;
      ws?.close();
    };
  }, [
    activeSessionKey,
    appendSystemMessage,
    clearPendingLatestAssistantAction,
    reconcilePendingLatestAssistantAction,
    stopLatestAssistantActionResync,
  ]);

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
    if (pendingLatestAssistantActionRef.current || streaming) return;
    const messageId = latestAssistantMessageId();
    if (!messageId) {
      appendSystemMessage("nothing to retry");
      return;
    }
    beginPendingLatestAssistantAction("retry", messageId);
    void dispatchLatestAssistantActionRef.current("retry").catch((error) => {
      clearPendingLatestAssistantAction();
      appendSystemMessage(error instanceof Error ? error.message : String(error));
    });
  }, [
    appendSystemMessage,
    beginPendingLatestAssistantAction,
    clearPendingLatestAssistantAction,
    latestAssistantMessageId,
    streaming,
  ]);

  const deleteLatest = useCallback(() => {
    if (pendingLatestAssistantActionRef.current || streaming) return;
    const messageId = latestAssistantMessageId();
    if (!messageId) {
      appendSystemMessage("nothing to delete");
      return;
    }
    beginPendingLatestAssistantAction("delete", messageId);
    void dispatchLatestAssistantActionRef.current("delete").catch((error) => {
      clearPendingLatestAssistantAction();
      appendSystemMessage(error instanceof Error ? error.message : String(error));
    });
  }, [
    appendSystemMessage,
    beginPendingLatestAssistantAction,
    clearPendingLatestAssistantAction,
    latestAssistantMessageId,
    streaming,
  ]);

  const notifyNewChat = useCallback(() => {
    appendSystemMessage("started fresh");
  }, [appendSystemMessage]);

  return {
    messages,
    connection,
    personaName,
    sessions,
    activeSessionKey,
    historyLoaded,
    streaming,
    pendingLatestAssistantAction,
    selectSession,
    send,
    abort,
    retry,
    deleteLatest,
    notifyNewChat,
  };
}
