import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, MessagePart, ToolEvent } from "../types";
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

interface PendingMessage {
  text: string;
  thinking: string;
  attachments?: Message["attachments"];
  thinkingStartedAt?: number;
  thinkingEndedAt?: number;
}

function mergeTool(
  existing: ToolEvent | undefined,
  patch: ToolEvent,
): ToolEvent {
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

function appendTextPart(parts: MessagePart[] | undefined, text: string): MessagePart[] {
  const existing = parts ?? [];
  const last = existing.at(-1);
  if (last?.type === "text") {
    return [...existing.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...existing, { type: "text", id: `text_${existing.length}`, text }];
}

function mergeToolPart(parts: MessagePart[] | undefined, patch: ToolEvent): MessagePart[] {
  const existing = parts ?? [];
  const index = existing.findIndex((part) => part.type === "tool" && part.tool.id === patch.id);
  if (index >= 0) {
    const next = existing.slice();
    const part = next[index];
    if (part?.type === "tool") next[index] = { ...part, tool: mergeTool(part.tool, patch) };
    return next;
  }
  return [...existing, { type: "tool", id: `tool_${patch.id}`, tool: patch }];
}

export interface ChatHook {
  messages: Message[];
  connection: ConnectionState;
  personaName: string;
  sessions: SessionInfo[];
  activeSessionKey: string | undefined;
  selectSession: (key: string) => void;
  send: (text: string) => Promise<void>;
}

export function useChat(): ChatHook {
  const [messages, setMessages] = useState<Message[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [personaName, setPersonaName] = useState<string>("Familiar");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionKey, setActiveSessionKey] = useState<string | undefined>(undefined);

  const lastEventIdRef = useRef<string | null>(null);
  const pendingRef = useRef<Map<string, PendingMessage>>(new Map());
  const sendRef = useRef<(text: string) => Promise<void>>(async () => undefined);

  const upsertMessage = useCallback(
    (id: string, patch: Partial<Message> & { role?: Message["role"]; who?: string }) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = { ...next[idx], ...patch };
          return next;
        }
        const seed: Message = {
          id,
          role: patch.role ?? "assistant",
          who: patch.who ?? "Familiar",
          text: patch.text ?? "",
          thinking: patch.thinking,
          thinkingMs: patch.thinkingMs,
          attachments: patch.attachments,
          parts: patch.parts,
          usage: patch.usage,
          ts: patch.ts ?? Date.now(),
        };
        return [...prev, seed];
      });
    },
    [],
  );

  const handleEvent = useCallback(
    (event: StreamEvent) => {
      if ("eventId" in event) lastEventIdRef.current = event.eventId;

      switch (event.type) {
        case "message_started": {
          pendingRef.current.set(event.messageId, { text: "", thinking: "" });
          upsertMessage(event.messageId, {
            role: event.role === "user" ? "user" : "assistant",
            who: event.who,
            text: "",
            ts: event.ts,
          });
          break;
        }
        case "delta": {
          const pending = pendingRef.current.get(event.messageId) ?? { text: "", thinking: "" };
          if (event.part === "thinking") {
            pending.thinking += event.content;
            pending.thinkingStartedAt ??= Date.now();
            pending.thinkingEndedAt = Date.now();
            upsertMessage(event.messageId, { thinking: pending.thinking });
          } else {
            if (pending.thinkingStartedAt && !pending.thinkingEndedAt) {
              pending.thinkingEndedAt = Date.now();
            }
            pending.text += event.content;
            setMessages((prev) =>
              prev.map((message) =>
                message.id === event.messageId
                  ? { ...message, text: pending.text, parts: appendTextPart(message.parts, event.content) }
                  : message,
              ),
            );
          }
          pendingRef.current.set(event.messageId, pending);
          break;
        }
        case "message_completed": {
          const pending = pendingRef.current.get(event.messageId);
          const computedThinkingMs =
            event.thinkingMs ??
            (pending?.thinkingStartedAt && pending?.thinkingEndedAt
              ? Math.max(0, pending.thinkingEndedAt - pending.thinkingStartedAt)
              : undefined);
          upsertMessage(event.messageId, {
            thinkingMs: computedThinkingMs,
            ...(event.attachments ? { attachments: event.attachments } : {}),
            ...(event.usage ? { usage: event.usage } : {}),
          });
          pendingRef.current.delete(event.messageId);
          break;
        }
        case "tool_event": {
          setMessages((prev) =>
            prev.map((message) => {
              if (message.id !== event.messageId) return message;
              const tools = message.tools ? [...message.tools] : [];
              const index = tools.findIndex((tool) => tool.id === event.tool.id);
              if (index >= 0) {
                tools[index] = mergeTool(tools[index], event.tool);
              } else {
                tools.push(event.tool);
              }
              return { ...message, tools, parts: mergeToolPart(message.parts, event.tool) };
            }),
          );
          break;
        }
        case "error": {
          setMessages((prev) => [
            ...prev,
            {
              id: uid(),
              role: "system",
              who: "",
              text: `error · ${event.code}: ${event.message}`,
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
    [upsertMessage, activeSessionKey],
  );

  // Bootstrap: load auth/persona name + sessions, pick default
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

  // Per-session: load history + open WebSocket. Re-runs on session change.
  useEffect(() => {
    if (!activeSessionKey) return;
    localStorage.setItem("familiar.activeSession", activeSessionKey);

    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    setMessages([]);
    pendingRef.current.clear();
    lastEventIdRef.current = null;

    fetchHistory(activeSessionKey)
      .then((res) => {
        if (!cancelled) setMessages(res.messages);
      })
      .catch(() => undefined);

    const connect = () => {
      if (cancelled) return;
      setConnection("connecting");
      const socket = new WebSocket(streamUrl(activeSessionKey));
      ws = socket;

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
          handleEvent(data);
        } catch {
          /* ignore malformed frame */
        }
      });

      socket.addEventListener("close", () => {
        if (cancelled) return;
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

    sendRef.current = async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      await sendMessageApi(trimmed, uid(), activeSessionKey);
    };

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [activeSessionKey, handleEvent]);

  const send = useCallback((text: string) => sendRef.current(text), []);
  const selectSession = useCallback((key: string) => setActiveSessionKey(key), []);

  return { messages, connection, personaName, sessions, activeSessionKey, selectSession, send };
}
