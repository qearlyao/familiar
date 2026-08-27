import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { Mic, PhoneOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChat } from "@/lib/useChat";
import { useVoiceCall } from "@/lib/useVoiceCall";
import { createSpeechFeed } from "@/lib/voiceSpeech";
import type { Message } from "@/types";

function InkField({ speaking, level }: { speaking: boolean; level: number }) {
  // level rides the analyser so the blobs breathe with whoever is talking
  const scale = 1 + Math.min(level, 1) * 0.26;
  return (
    <div className={cn("ink-field", speaking && "ink-field-speaking")} aria-hidden>
      <div className="ink-blob ink-blob-a" style={{ "--ink-scale": scale } as CSSProperties} />
      <div className="ink-blob ink-blob-b" style={{ "--ink-scale": 1 + (scale - 1) * 0.6 } as CSSProperties} />
      <div className="ink-blob ink-blob-c" style={{ "--ink-scale": 1 + (scale - 1) * 0.35 } as CSSProperties} />
      <div className="ink-veil" />
    </div>
  );
}

function assistantText(message: Message | undefined): string {
  if (!message || message.role !== "assistant") return "";
  return message.steps
    .filter((step) => step.kind === "text")
    .map((step) => step.text)
    .join("");
}

export function VoiceCallPage({ nav }: { nav?: ReactNode }) {
  const chat = useChat();
  const sendRef = useRef(chat.send);
  const latestRef = useRef<Message | undefined>(undefined);
  useLayoutEffect(() => {
    sendRef.current = chat.send;
    latestRef.current = chat.messages[chat.messages.length - 1];
  });

  const onTranscript = useCallback((text: string) => {
    void sendRef.current(text).catch(() => undefined);
  }, []);

  const interruptedMessageRef = useRef<string | undefined>(undefined);
  const tailRef = useRef<HTMLDivElement>(null);
  const feed = useMemo(() => createSpeechFeed(), []);
  const spokenMessageRef = useRef<string | undefined>(undefined);
  const closedMessageRef = useRef<string | undefined>(undefined);
  const callBaselineAssistantRef = useRef<string | undefined>(undefined);
  const onBargeIn = useCallback(() => {
    const latest = latestRef.current;
    interruptedMessageRef.current = latest?.role === "assistant" ? latest.id : undefined;
    spokenMessageRef.current = undefined;
    closedMessageRef.current = undefined;
    feed.reset();
  }, [feed]);
  const {
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
    showLine,
  } = useVoiceCall({
    onTranscript,
    onBargeIn,
  });

  const latest = chat.messages[chat.messages.length - 1];
  const replyText = assistantText(latest);
  const live = state === "live";

  // Forward each streamed text delta; ElevenLabs owns its own audio buffering.
  useEffect(() => {
    if (!live || !latest || latest.role !== "assistant") return;
    if (latest.id === callBaselineAssistantRef.current) return;
    if (latest.id === interruptedMessageRef.current) return;
    if (spokenMessageRef.current !== latest.id) {
      spokenMessageRef.current = latest.id;
      interruptedMessageRef.current = undefined;
      feed.reset();
    }
    for (const chunk of feed.push(replyText)) speak(chunk);
  }, [live, latest, replyText, feed, speak]);

  // Turn finished: flush the upstream buffer and close out the audio.
  useEffect(() => {
    const id = spokenMessageRef.current;
    if (!live || chat.streaming || id === undefined || closedMessageRef.current === id) return;
    closedMessageRef.current = id;
    for (const chunk of feed.end()) speak(chunk);
    endSpeech();
    if (replyText.trim()) showLine("them", replyText.trim(), true);
  }, [live, chat.streaming, feed, speak, endSpeech, replyText, showLine]);

  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines]);

  const unavailable = config?.enabled === false;
  const currentLine = lines.at(-1);
  const status = live ? (speaking ? "speaking" : "listening") : state === "connecting" ? "connecting" : "ready when you are";
  const pushMode = config?.voiceCallMode === "push_to_talk";
  const pushToTalk = live && pushMode;
  const pttGestureRef = useRef(false);
  const pointerDownAtRef = useRef<number | undefined>(undefined);
  const controlLabel = pushToTalk ? "hold to speak" : live || state === "connecting" ? "end voice call" : "start voice call";
  const startCall = () => {
    callBaselineAssistantRef.current = latest?.role === "assistant" ? latest.id : undefined;
    spokenMessageRef.current = undefined;
    closedMessageRef.current = undefined;
    interruptedMessageRef.current = undefined;
    feed.reset();
    start();
  };

  return (
    <div className="voice-stage relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <InkField speaking={speaking} level={level} />
      <header className="voice-header relative z-10 px-3 py-4 md:px-8">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          {nav}
          <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <h1 className="font-serif text-2xl leading-none tracking-tight">voice</h1>
            <p className={cn("voice-status", live && "voice-status-live")}>
              <span className="voice-status-dot" aria-hidden />
              {status}
            </p>
          </div>
        </div>
      </header>

      <main className="voice-main relative z-10 min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6">
        <div className="voice-focus mx-auto flex max-w-2xl flex-col items-center text-center">
          <div
            className={cn("voice-pulse", speaking && "voice-pulse-active")}
            style={{ "--voice-scale": 1 + Math.min(level, 1) * 0.24 } as CSSProperties}
            aria-hidden
          />
          <p className="voice-kicker">{currentLine ? (currentLine.who === "you" ? "you said" : "they said") : "a quiet line between you"}</p>
          <p className={cn("voice-current-line font-serif", !currentLine && "voice-current-line-empty")} aria-live="polite">
            {currentLine?.text || (unavailable ? "voice needs an elevenlabs key on the other end" : "say something when you're ready")}
          </p>
        </div>

        {lines.length > 1 ? (
          <div className="voice-transcript mx-auto max-w-2xl" aria-label="conversation transcript">
            {lines.slice(0, -1).map((line) => (
              <p key={line.id} className={cn("voice-line", line.who === "you" ? "voice-line-you" : "voice-line-them")}>
                {line.text}
              </p>
            ))}
            <div ref={tailRef} />
          </div>
        ) : (
          <div ref={tailRef} />
        )}
      </main>

      <footer className="voice-footer relative z-10 flex flex-col items-center gap-3 px-6 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {error ? <p className="font-serif text-xs italic text-destructive" role="alert">{error}</p> : null}
        <button
          type="button"
          onClick={() => {
            if (pttGestureRef.current) {
              pttGestureRef.current = false;
              return;
            }
            if (pushToTalk) return;
            if (live || state === "connecting") stop();
            else startCall();
          }}
          onPointerDown={(event) => {
            if (!pushMode) return;
            // an idle/ended call arms on the click instead, so the press is not a gesture
            if (!live && state !== "connecting") return;
            event.currentTarget.setPointerCapture(event.pointerId);
            pttGestureRef.current = true;
            pointerDownAtRef.current = performance.now();
            beginUtterance();
          }}
          onPointerUp={() => {
            if (!pushMode || !pttGestureRef.current) return;
            const elapsed = pointerDownAtRef.current === undefined ? 0 : performance.now() - pointerDownAtRef.current;
            pointerDownAtRef.current = undefined;
            // too short to be speech: read it as a tap to hang up, not a turn
            if (elapsed < 350) {
              endUtterance(false);
              if (live || state === "connecting") stop();
              return;
            }
            endUtterance(true);
          }}
          onPointerCancel={() => {
            if (pushMode && pttGestureRef.current) {
              endUtterance(false);
              pointerDownAtRef.current = undefined;
              pttGestureRef.current = false;
            }
          }}
          onContextMenu={(event) => {
            if (pushMode) event.preventDefault();
          }}
          disabled={unavailable}
          aria-label={controlLabel}
          className={cn(
            "voice-call-control",
            live && !pushToTalk && "voice-call-control-live",
            pushToTalk && "voice-call-control-ptt",
            unavailable && "opacity-40",
          )}
        >
          {live && !pushToTalk ? <PhoneOff className="size-6" /> : <Mic className="size-6" />}
        </button>
      </footer>
    </div>
  );
}
