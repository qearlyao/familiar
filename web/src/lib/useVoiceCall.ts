import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchVoiceConfig, voiceUrl, type VoiceConfig } from "./api";
import { createVoicePlayer, startMicCapture, type MicCapture, type VoicePlayer } from "./voiceAudio";

export type CallState = "idle" | "connecting" | "live" | "ended";

export interface VoiceLine {
  id: string;
  who: "you" | "them";
  text: string;
  final: boolean;
}

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
  start: () => void;
  stop: () => void;
  speak: (text: string) => void;
  endSpeech: () => void;
  beginUtterance: () => void;
  endUtterance: (commit: boolean) => void;
  showLine: (who: VoiceLine["who"], text: string, final: boolean) => void;
}

export function useVoiceCall({
  onTranscript,
  onBargeIn,
}: { onTranscript?: (text: string) => void; onBargeIn?: () => void } = {}): VoiceCallHook {
  const [state, setState] = useState<CallState>("idle");
  const [config, setConfig] = useState<VoiceConfig>();
  const [lines, setLines] = useState<VoiceLine[]>([]);
  const [error, setError] = useState<string>();
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<VoicePlayer | null>(null);
  const voiceCallModeRef = useRef<VoiceConfig["voiceCallMode"]>("continuous");
  const pushToTalkRef = useRef(false);
  const pushToTalkPendingRef = useRef<ArrayBuffer | undefined>(undefined);
  const captureStartingRef = useRef(false);
  // held in a ref so a changing callback never tears down the socket
  const onTranscriptRef = useRef(onTranscript);
  const onBargeInRef = useRef(onBargeIn);
  useLayoutEffect(() => {
    onTranscriptRef.current = onTranscript;
    onBargeInRef.current = onBargeIn;
  });

  useEffect(() => {
    let cancelled = false;
    void fetchVoiceConfig()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "voice is out of reach");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const teardown = useCallback(() => {
    pushToTalkRef.current = false;
    pushToTalkPendingRef.current = undefined;
    captureStartingRef.current = false;
    micRef.current?.stop();
    micRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "close" }));
    socket?.close();
    playerRef.current?.clear();
    playerRef.current?.close();
    playerRef.current = null;
    setSpeaking(false);
    setLevel(0);
  }, []);

  useEffect(() => teardown, [teardown]);

  // one rAF loop drives the ink field from whichever side is making sound
  useEffect(() => {
    if (state !== "live") return;
    let frame = 0;
    const tick = () => {
      const them = playerRef.current?.level() ?? 0;
      const you = micRef.current?.level() ?? 0;
      setLevel(Math.max(them, you));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state]);

  const appendLine = useCallback((who: VoiceLine["who"], text: string, final: boolean) => {
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.who === who && !last.final) {
        const next = prev.slice(0, -1);
        return [...next, { ...last, text, final }];
      }
      return [...prev, { id: `${who}-${prev.length}-${text.length}`, who, text, final }];
    });
  }, []);

  // capture runs for the whole call; push-to-talk only gates forwarding
  const startCapture = useCallback(() => {
    if (micRef.current || captureStartingRef.current) return;
    captureStartingRef.current = true;
    void startMicCapture(
      (pcm) => {
        const live = socketRef.current;
        if (voiceCallModeRef.current === "push_to_talk") {
          if (!pushToTalkRef.current) return;
          // hold the newest chunk back so the release has something to commit
          const pending = pushToTalkPendingRef.current;
          pushToTalkPendingRef.current = pcm;
          if (pending && live?.readyState === WebSocket.OPEN)
            live.send(JSON.stringify({ type: "audio", audioBase64: toBase64(pending), sampleRate: 16_000 }));
          return;
        }
        if (live?.readyState !== WebSocket.OPEN) return;
        live.send(JSON.stringify({ type: "audio", audioBase64: toBase64(pcm), sampleRate: 16_000 }));
      },
      () => {
        if (voiceCallModeRef.current === "push_to_talk" && !pushToTalkRef.current) return;
        if (!playerRef.current?.playing()) return;
        playerRef.current.clear();
        setSpeaking(false);
        socketRef.current?.send(JSON.stringify({ type: "tts_cancel" }));
        onBargeInRef.current?.();
      },
    )
      .then((capture) => {
        captureStartingRef.current = false;
        if (!socketRef.current) {
          capture.stop();
          return;
        }
        micRef.current = capture;
        setState("live");
      })
      .catch((err: unknown) => {
        captureStartingRef.current = false;
        setError(err instanceof Error ? err.message : "the mic stayed shut");
        teardown();
        setState("ended");
      });
  }, [teardown]);

  const openCall = useCallback((voiceCallMode: VoiceConfig["voiceCallMode"]) => {
    if (socketRef.current) return;
    voiceCallModeRef.current = voiceCallMode;
    setError(undefined);
    setLines([]);
    setState("connecting");

    const socket = new WebSocket(voiceUrl());
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      playerRef.current = createVoicePlayer();
      startCapture();
    });

    socket.addEventListener("message", (event) => {
      let message: unknown;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const body = message as Record<string, unknown>;
      if (body.type === "transcript" && typeof body.text === "string") {
        const final = body.final === true;
        appendLine("you", body.text, final);
        // a committed transcript is a finished turn: hand it up to drive the agent
        if (final && body.text.trim()) onTranscriptRef.current?.(body.text.trim());
        return;
      }
      if (body.type === "audio" && typeof body.audioBase64 === "string") {
        playerRef.current?.enqueue(body.audioBase64);
        setSpeaking(true);
        return;
      }
      if (body.type === "tts_done") {
        setSpeaking(false);
        return;
      }
      // the upstream transcriber idles out between turns; the relay reopens it on the next press
      if (body.type === "stt_closed") return;
      if (body.type === "error" && typeof body.message === "string") setError(body.message);
    });

    socket.addEventListener("close", () => {
      if (socketRef.current !== socket) return;
      teardown();
      setState("ended");
    });
    socket.addEventListener("error", () => setError("the line dropped"));
  }, [appendLine, startCapture, teardown]);

  const start = useCallback(() => {
    if (socketRef.current) return;
    setError(undefined);
    setLines([]);
    setState("connecting");
    void fetchVoiceConfig()
      .then((next) => {
        setConfig(next);
        openCall(next.voiceCallMode);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "voice is out of reach");
        setState("ended");
      });
  }, [openCall]);

  const stop = useCallback(() => {
    teardown();
    setState("ended");
  }, [teardown]);

  // Text chunks are punctuation-bounded by the page feed before they reach the relay.
  const speak = useCallback((text: string) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN || !text.trim()) return;
    setSpeaking(true);
    socket.send(JSON.stringify({ type: "tts", text }));
  }, []);

  const endSpeech = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "tts_end" }));
  }, []);

  const beginUtterance = useCallback(() => {
    if (voiceCallModeRef.current !== "push_to_talk") return;
    pushToTalkPendingRef.current = undefined;
    pushToTalkRef.current = true;
    if (playerRef.current?.playing()) {
      playerRef.current.clear();
      setSpeaking(false);
      socketRef.current?.send(JSON.stringify({ type: "tts_cancel" }));
      onBargeInRef.current?.();
    }
  }, []);

  const endUtterance = useCallback((commit: boolean) => {
    if (!pushToTalkRef.current) return;
    pushToTalkRef.current = false;
    const pending = pushToTalkPendingRef.current;
    pushToTalkPendingRef.current = undefined;
    const socket = socketRef.current;
    if (!commit || socket?.readyState !== WebSocket.OPEN || !pending) return;
    socket.send(JSON.stringify({ type: "audio", audioBase64: toBase64(pending), commit: true, sampleRate: 16_000 }));
  }, []);

  return {
    state,
    config,
    lines,
    error,
    speaking,
    level,
    start,
    stop,
    speak,
    endSpeech,
    beginUtterance,
    endUtterance,
    showLine: appendLine,
  };
}
