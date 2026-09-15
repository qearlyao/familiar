import { useCallback, useEffect, useRef, useState } from "react";
import { fetchVoiceConfig, voiceUrl, type VoiceConfig } from "./api";
import { createVoicePlayer, startMicCapture, type MicCapture, type VoicePlayer } from "./voiceAudio";
import { hasSilentMarker, stripStreamingTail } from "./silentMarker";
import { placeLine, type VoiceLine } from "./voiceLines";
import { createSpeechFeed } from "./voiceSpeech";

export type CallState = "idle" | "connecting" | "live" | "ended";


function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // ponytail: chunked so a long buffer never blows the argument list
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export interface VoiceCallHook {
  state: CallState;
  config: VoiceConfig | undefined;
  lines: VoiceLine[];
  error: string | undefined;
  speaking: boolean;
  level: number;
  muted: boolean;
  /** when the call picked up, for the clock */
  startedAt: number | undefined;
  /** how long the last call ran, once it has ended */
  durationMs: number;
  start: () => void;
  stop: () => void;
  setMuted: (muted: boolean) => void;
  /** write a line instead of saying it */
  say: (text: string) => void;
  /** put an ended call away and go back to idle */
  reset: () => void;
}

/** A call is its own conversation on the server: this side carries sound and shows the lines. */
export function useVoiceCall(): VoiceCallHook {
  const [state, setState] = useState<CallState>("idle");
  const [config, setConfig] = useState<VoiceConfig>();
  const [lines, setLines] = useState<VoiceLine[]>([]);
  const [error, setError] = useState<string>();
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const [muted, setMutedState] = useState(false);
  const [startedAt, setStartedAt] = useState<number>();
  const [durationMs, setDurationMs] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<VoicePlayer | null>(null);
  const mutedRef = useRef(false);
  const startedAtRef = useRef(0);
  const feedRef = useRef(createSpeechFeed());
  const replyRef = useRef<string | undefined>(undefined);
  const interruptedRef = useRef<string | undefined>(undefined);

  const refreshConfig = useCallback(
    () =>
      fetchVoiceConfig().then((next) => {
        setConfig(next);
        return next;
      }),
    [],
  );

  useEffect(() => {
    void refreshConfig().catch((err: unknown) => setError(err instanceof Error ? err.message : "voice is out of reach"));
  }, [refreshConfig]);

  const teardown = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "close" }));
    socket?.close();
    playerRef.current?.clear();
    playerRef.current?.close();
    playerRef.current = null;
    feedRef.current.reset();
    replyRef.current = undefined;
    interruptedRef.current = undefined;
    setSpeaking(false);
    setLevel(0);
  }, []);

  useEffect(() => teardown, [teardown]);

  const end = useCallback(() => {
    if (!socketRef.current && !micRef.current) return;
    teardown();
    setDurationMs(startedAtRef.current ? Date.now() - startedAtRef.current : 0);
    setState("ended");
  }, [teardown]);

  // one rAF loop drives the ink field from whichever side is making sound
  useEffect(() => {
    if (state !== "live") return;
    let frame = 0;
    const tick = () => {
      const them = playerRef.current?.level() ?? 0;
      const you = mutedRef.current ? 0 : (micRef.current?.level() ?? 0);
      setLevel(Math.max(them, you));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state]);

  const send = (body: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
  };

  const putLine = useCallback((who: VoiceLine["who"], text: string, final: boolean, id?: string) => {
    const at = Date.now() - startedAtRef.current;
    setLines((prev) => placeLine(prev, who, text, final, at, id));
  }, []);

  const dropLine = useCallback((id: string) => setLines((prev) => prev.filter((line) => line.id !== id)), []);

  // you talked over the reply: silence it here and stop the rest being written
  const bargeIn = useCallback(() => {
    if (!playerRef.current?.playing()) return;
    playerRef.current.clear();
    setSpeaking(false);
    interruptedRef.current = replyRef.current;
    feedRef.current.reset();
    send({ type: "tts_cancel" });
  }, []);

  const start = useCallback(() => {
    if (socketRef.current) return;
    setError(undefined);
    setLines([]);
    setMutedState(false);
    mutedRef.current = false;
    setState("connecting");

    const socket = new WebSocket(voiceUrl());
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      playerRef.current = createVoicePlayer();
      void startMicCapture(
        (pcm) => {
          if (mutedRef.current || socketRef.current?.readyState !== WebSocket.OPEN) return;
          socketRef.current.send(JSON.stringify({ type: "audio", audioBase64: toBase64(pcm), sampleRate: 16_000 }));
        },
        () => {
          if (!mutedRef.current) bargeIn();
        },
      )
        .then((capture) => {
          if (socketRef.current !== socket) {
            capture.stop();
            return;
          }
          micRef.current = capture;
          startedAtRef.current = Date.now();
          setStartedAt(startedAtRef.current);
          setState("live");
          // refresh the keep choice so a settings change since load counts for this call
          void refreshConfig().catch(() => undefined);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "the mic stayed shut");
          teardown();
          setState("idle");
        });
    });

    socket.addEventListener("message", (event) => {
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(typeof event.data === "string" ? event.data : "");
        if (typeof parsed !== "object" || parsed === null) return;
        body = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      if (body.type === "transcript" && typeof body.text === "string") {
        // an empty final still closes the open partial; empty lines are never shown or kept
        putLine("you", body.text, body.final === true);
        return;
      }
      if ((body.type === "reply" || body.type === "reply_end") && typeof body.id === "string" && typeof body.text === "string") {
        const id = body.id;
        if (replyRef.current !== id) {
          replyRef.current = id;
          feedRef.current.reset();
        }
        const interrupted = interruptedRef.current === id;
        if (body.type === "reply") {
          if (!interrupted) for (const chunk of feedRef.current.push(body.text)) send({ type: "tts", id, text: chunk });
          // a silent turn is for the eyes only, and never lands as a spoken line
          if (!hasSilentMarker(body.text)) putLine("them", stripStreamingTail(body.text), false, id);
          return;
        }
        if (!interrupted) {
          for (const chunk of feedRef.current.end()) send({ type: "tts", id, text: chunk });
          send({ type: "tts_end", id });
        }
        if (body.silent === true || !body.text) dropLine(id);
        else putLine("them", body.text, true, id);
        return;
      }
      // you spoke again before the reply was done: the server cut it, so silence what's left of it
      if (body.type === "interrupted" && typeof body.id === "string") {
        interruptedRef.current = body.id;
        if (replyRef.current === body.id) feedRef.current.reset();
        playerRef.current?.clear();
        setSpeaking(false);
        return;
      }
      if (body.type === "audio" && typeof body.audioBase64 === "string") {
        // audio of a cut reply can still be on the wire; it's dropped until the next reply speaks
        if (replyRef.current && interruptedRef.current === replyRef.current) return;
        playerRef.current?.enqueue(body.audioBase64);
        setSpeaking(true);
        return;
      }
      if (body.type === "tts_done") {
        setSpeaking(false);
        return;
      }
      if (body.type === "error" && typeof body.message === "string") setError(body.message);
    });

    socket.addEventListener("close", () => {
      if (socketRef.current !== socket) return;
      end();
    });
    socket.addEventListener("error", () => setError("the line dropped"));
  }, [bargeIn, dropLine, end, putLine, refreshConfig, teardown]);

  const setMuted = useCallback((next: boolean) => {
    mutedRef.current = next;
    setMutedState(next);
  }, []);

  const say = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || socketRef.current?.readyState !== WebSocket.OPEN) return;
      bargeIn();
      putLine("you", trimmed, true, `typed-${Date.now()}`);
      send({ type: "say", text: trimmed });
    },
    [bargeIn, putLine],
  );

  const reset = useCallback(() => {
    setLines([]);
    setError(undefined);
    setStartedAt(undefined);
    setState("idle");
  }, []);

  return { state, config, lines, error, speaking, level, muted, startedAt, durationMs, start, stop: end, setMuted, say, reset };
}
