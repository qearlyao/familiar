import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { keepVoiceCall, setConfig, type VoiceKeep } from "@/lib/api";
import { useVoiceCall } from "@/lib/useVoiceCall";
import { clock, type VoiceLine } from "@/lib/voiceLines";
import { IconArrow, IconHangUp, IconLeave, IconMic, IconMicOff, RailChat } from "./organicIcons";
import "./voice.css";

/** how long the chrome stays up after you last moved */
const CHROME_REST_MS = 3500;

function spokenLength(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (!minutes) return unit(seconds, "second");
  return `${unit(minutes, "minute")}, ${unit(seconds % 60, "second")}`;
}

/** a long reply keeps only its newest sentences on stage */
function stageText(text: string, max = 180): string {
  if (text.length <= max) return text;
  const tail = text.slice(-max);
  const boundary = tail.search(/[.!?。！？]\s+\S/);
  return boundary >= 0 ? tail.slice(boundary + 1).trimStart() : `…${tail.slice(tail.indexOf(" ") + 1)}`;
}

function Wave({ small }: { small?: boolean }) {
  return (
    <span className="voice-wave" data-small={small ? "" : undefined} aria-hidden>
      <span /><span /><span /><span />
    </span>
  );
}

function InkField({ level, speaking }: { level: number; speaking: boolean }) {
  // level rides the analyser so the blooms swell with whoever is talking
  const swell = { "--swell": 1 + Math.min(level, 1) * 0.22 } as CSSProperties;
  return (
    <div className="voice-ink" data-speaking={speaking ? "" : undefined} aria-hidden>
      <div className="voice-ink-blooms" style={swell}>
        <span className="voice-bloom voice-bloom-a" />
        <span className="voice-bloom voice-bloom-b" />
        <span className="voice-bloom voice-bloom-c" />
      </div>
      <div className="voice-ink-vignette" />
    </div>
  );
}

function Lines({ lines }: { lines: VoiceLine[] }) {
  const list = useRef<HTMLOListElement>(null);
  // keep the newest line in view inside the dock, without scrolling the page around it
  useEffect(() => {
    const scroller = list.current?.parentElement;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [lines]);
  return (
    <ol ref={list} className="voice-lines" aria-label="what's been said">
      {lines.map((line) => (
        <li key={line.id} data-who={line.who}>
          <time>{clock(line.at)}</time>
          <p>{line.text}</p>
        </li>
      ))}
    </ol>
  );
}

function KeepCard({
  lines,
  durationMs,
  onDone,
}: {
  lines: VoiceLine[];
  durationMs: number;
  onDone: (error?: string) => void;
}) {
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState<"transcript" | "summary" | "discard">();

  const choose = async (choice: "transcript" | "summary" | "discard") => {
    setBusy(choice);
    try {
      if (remember) await setConfig("web.voice_keep", choice);
      await keepVoiceCall({ choice, durationMs, lines: lines.map(({ who, text, at }) => ({ who, text, at })) });
      onDone();
    } catch (err) {
      setBusy(undefined);
      onDone(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="voice-keep">
      <div className="voice-keep-ended">
        <span>{spokenLength(durationMs)}</span>
        <small>the call has ended</small>
      </div>
      <section className="voice-keep-card" aria-label="keep this call">
        <header>
          <h2>Keep this in the conversation?</h2>
          <time>{clock(durationMs)}</time>
          <p>Nothing is written to the chat until you choose.</p>
        </header>
        <div className="voice-keep-choices">
          <button type="button" data-choice="transcript" disabled={!!busy} onClick={() => void choose("transcript")}>
            <b><span className="voice-keep-long">keep the </span>whole transcript</b>
            <small>{lines.length} {lines.length === 1 ? "line" : "lines"}, with times</small>
          </button>
          <button type="button" data-choice="summary" disabled={!!busy} onClick={() => void choose("summary")}>
            <b>{busy === "summary" ? "writing it down…" : <><span className="voice-keep-long">keep a </span>summary only</>}</b>
            <small>a few lines about what was said</small>
          </button>
          <button type="button" data-choice="discard" disabled={!!busy} onClick={() => void choose("discard")}>
            <b>discard<span className="voice-keep-long"> it</span></b>
          </button>
        </div>
        <button type="button" className="voice-keep-remember" aria-pressed={remember} onClick={() => setRemember((v) => !v)}>
          <span aria-hidden />
          remember my choice for next time
        </button>
        <p className="voice-keep-note">Whatever you pick lands as one entry in the chat, timestamped.</p>
      </section>
    </div>
  );
}

function LiveBar({ name, startedAt, speaking, onReturn, onHangUp }: { name: string; startedAt?: number; speaking: boolean; onReturn: () => void; onHangUp: () => void }) {
  const now = useNow(true);
  return createPortal(
    <div className="voice-live-bar" role="status">
      <span className="voice-live-dot" aria-hidden />
      <span className="voice-live-name"><span className="voice-desktop-only">on a call with </span>{name}</span>
      {speaking && <Wave small />}
      <time>{startedAt ? clock(now - startedAt) : "--:--"}</time>
      <button type="button" className="voice-live-return" onClick={onReturn}>return</button>
      <button type="button" className="voice-live-hangup" title="hang up" aria-label="hang up" onClick={onHangUp}>
        <IconHangUp size={17} />
      </button>
    </div>,
    document.body,
  );
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);
  return now;
}

export function VoiceCallPage({
  onBack,
  onShow,
  onOpenSettings,
  visible,
  personaName: name,
}: {
  onBack: () => void;
  onShow: () => void;
  onOpenSettings: (tab: "voice") => void;
  visible: boolean;
  personaName: string;
}) {
  const call = useVoiceCall();
  const { state, config, lines, error, speaking, level, muted, startedAt } = call;
  const [awake, setAwake] = useState(true);
  const [readBack, setReadBack] = useState(false);
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState("");
  const [keepError, setKeepError] = useState<string>();
  const restTimer = useRef<number | undefined>(undefined);
  const live = state === "live";
  const now = useNow(live && visible);

  const said = lines.filter((line) => line.text.trim());
  const keep: VoiceKeep = config?.keep ?? "ask";

  // a call that ends with nothing said, or with its keeping already decided, never asks
  useEffect(() => {
    if (state !== "ended") return;
    const done = () => call.reset();
    if (!said.length) return done();
    if (keep === "ask") return;
    void keepVoiceCall({ choice: keep, durationMs: call.durationMs, lines: said.map(({ who, text, at }) => ({ who, text, at })) })
      .then(() => setKeepError(undefined), (err: unknown) => setKeepError(err instanceof Error ? err.message : String(err)))
      .finally(done);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per ended call
  }, [state]);

  const wake = () => {
    setAwake(true);
    window.clearTimeout(restTimer.current);
    restTimer.current = window.setTimeout(() => setAwake(false), CHROME_REST_MS);
  };
  // the chrome starts sinking the moment the line opens, not only after you first move
  useEffect(() => {
    if (!live || !visible) return;
    restTimer.current = window.setTimeout(() => setAwake(false), CHROME_REST_MS);
    return () => window.clearTimeout(restTimer.current);
  }, [live, visible]);

  useEffect(() => {
    if (!visible || state !== "connecting") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") call.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, state, call]);

  const leave = () => {
    setReadBack(false);
    onBack();
  };

  const current = said.at(-1);
  const sunk = live && !awake && !readBack && !writing;
  const unavailable = config?.enabled === false;

  if (!visible) {
    return state === "live" || state === "connecting" ? (
      <LiveBar name={name} startedAt={startedAt} speaking={speaking} onReturn={onShow} onHangUp={() => { call.stop(); onShow(); }} />
    ) : null;
  }

  if (state === "ended" && said.length && keep === "ask") {
    return (
      <div className="voice-room room-view" data-state="ended">
        <InkField level={0} speaking={false} />
        <KeepCard
          lines={said}
          durationMs={call.durationMs}
          onDone={(err) => {
            setKeepError(err);
            if (!err) call.reset();
          }}
        />
        {keepError && <p className="voice-error voice-error-floating" role="alert"><span>it didn't reach the chat</span>{keepError}</p>}
      </div>
    );
  }

  if (!live && state !== "ended") {
    return (
      <div className="voice-room room-view" data-state={state}>
        <InkField level={0} speaking={false} />
        {state === "connecting" ? (
          <button type="button" className="voice-connecting" onClick={call.stop}>
            <b>picking up…</b>
            <small><span className="voice-desktop-only">press escape to stop</span><span className="voice-mobile-only">tap to stop</span></small>
          </button>
        ) : unavailable ? (
          <div className="voice-idle">
            <span className="voice-kicker">voice is off</span>
            <p>{name} has no voice until an elevenlabs key is set.</p>
            <div className="voice-idle-row">
              <button type="button" className="voice-primary is-small" onClick={() => onOpenSettings("voice")}>
                open voice settings
                <IconArrow size={14} />
              </button>
              <small>writing still works</small>
            </div>
          </div>
        ) : (
          <div className="voice-idle">
            <p>{name}'s quiet. Call and the line opens.</p>
            <div className="voice-idle-row">
              <button type="button" className="voice-primary" onClick={() => {
                  setKeepError(undefined);
                  setReadBack(false);
                  setWriting(false);
                  call.start();
                }}>
                <IconMic size={19} />
                call {name}
              </button>
              <small>
                {keep === "transcript" ? "the whole call lands in the chat afterwards" : keep === "summary" ? "a summary lands in the chat afterwards" : keep === "discard" ? "nothing is kept afterwards" : "nothing is kept unless you say so afterwards"}
              </small>
            </div>
            {(error || keepError) && (
              <p className="voice-error" role="alert">
                <span>{keepError ? "it didn't reach the chat" : "the line didn't open"}</span>
                {keepError ?? error}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="voice-room room-view"
      data-state="live"
      data-sunk={sunk ? "" : undefined}
      data-reading={readBack ? "" : undefined}
      onPointerMove={wake}
      onPointerDown={wake}
      onKeyDown={wake}
    >
      <InkField level={level} speaking={speaking} />
      <header className="voice-top">
        <button type="button" className="voice-back" onClick={leave} title="leave it running" aria-label="leave it running">
          <IconLeave size={15} />
          <span>leave it running</span>
        </button>
        <div className="voice-who">
          <span className="voice-live-dot" aria-hidden />
          <b>{name}</b>
          <time>{startedAt ? clock(now - startedAt) : "00:00"}</time>
        </div>
      </header>

      <main className="voice-stage" aria-live="polite">
        <span className="voice-orb" style={{ "--swell": 1 + Math.min(level, 1) * 0.3 } as CSSProperties} aria-hidden />
        <p className="voice-line" data-who={current?.who ?? "them"} data-empty={current ? undefined : ""}>
          {current ? stageText(current.text) : "say something when you're ready"}
        </p>
        {speaking && <Wave />}
      </main>

      <div className="voice-dock">
        <button type="button" className="voice-pull" aria-expanded={readBack} onClick={() => setReadBack((v) => !v)}>
          <span aria-hidden />
          <small>{readBack ? "push down to put it away" : "pull up to read back"}</small>
        </button>
        {/* the dock previews the two lines before the one on stage; pulled up, it has all of them */}
        {said.length > (readBack ? 0 : 1) && (
          <div className="voice-read">
            <Lines lines={readBack ? said : said.slice(-3, -1)} />
          </div>
        )}
        {writing && (
          <form
            className="voice-write"
            onSubmit={(event) => {
              event.preventDefault();
              call.say(draft);
              setDraft("");
            }}
          >
            <input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`write to ${name}…`} aria-label={`write to ${name}`} />
          </form>
        )}
        {error && <p className="voice-error" role="alert"><span>static on the line</span>{error}</p>}
        <div className="voice-controls">
          <button type="button" className="voice-round" data-slot="mute" aria-pressed={muted} title={muted ? "unmute your mic" : "mute your mic"} aria-label={muted ? "unmute your mic" : "mute your mic"} onClick={() => call.setMuted(!muted)}>
            {muted ? <IconMicOff size={21} /> : <IconMic size={21} />}
          </button>
          <button type="button" className="voice-round" data-slot="write" aria-pressed={writing} title="write instead" aria-label="write instead" onClick={() => setWriting((v) => !v)}>
            <RailChat size={21} />
          </button>
          <small className="voice-hint">{muted ? `mic off · ${name} can't hear you` : `open mic · ${name} pauses when you speak`}</small>
          <button type="button" className="voice-primary" data-slot="hangup" onClick={call.stop}>
            <IconHangUp size={20} />
            hang up
          </button>
        </div>
      </div>
    </div>
  );
}
