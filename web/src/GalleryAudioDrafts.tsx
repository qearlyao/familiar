import { useEffect, useRef, useState } from "react";
import { Pause, Pencil, Play } from "lucide-react";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// CLUSTERING SIMULATION. Real data is audio-dominant, so this renders a dense,
// time-grouped sheet (mostly recordings + a few images) to test whether the
// bloom audio tile stays calm and distinct at scale — the failure mode of the
// old waveform wall. Toggle frameless / soft / boxed and light / dark.
// Per-bloom rotation + scale + real duration give each clip its own fingerprint.
// View at ?demo=audio. Not wired into the production GalleryPage.
// ─────────────────────────────────────────────────────────────────────────────

type Variant = "frameless" | "soft" | "boxed";

// FNV-ish hash → deterministic per-id variation (no Math.random in render).
function seedFrom(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

function InkBloom({ id, playing, onClick }: { id: string; playing: boolean; onClick: () => void }) {
  const seed = seedFrom(id);
  const rotation = seed % 360;
  const scale = 0.86 + ((seed >> 4) % 30) / 100; // 0.86–1.15
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={playing ? "pause" : "play"}
      className={cn("df df-ink group relative grid size-20 place-items-center", playing && "is-playing")}
    >
      <span
        className="df-ink-field"
        style={{ transform: `rotate(${rotation}deg) scale(${scale})` }}
        aria-hidden
      >
        <span className="df-blob df-blob-a" />
        <span className="df-blob df-blob-b" />
        <span className="df-blob df-blob-c" />
        <span className="df-blob df-blob-d" />
      </span>
      <span className="df-glyph relative z-[2] grid place-items-center">
        {playing ? (
          <Pause className="size-5 fill-current" strokeWidth={0} />
        ) : (
          <Play className="size-5 translate-x-px fill-current" strokeWidth={0} />
        )}
      </span>
    </button>
  );
}

interface AudioPiece {
  kind: "audio";
  id: string;
  durationSeconds: number;
  note: string;
  src: string;
}
interface ImagePiece {
  kind: "image";
  id: string;
  gradient: string;
  height: number;
  note: string;
}
type Piece = AudioPiece | ImagePiece;

// A 0.4s tone so inline play works without external assets.
function tone(seconds: number, freq: number): string {
  const rate = 8000;
  const samples = Math.floor(rate * seconds);
  const buf = new Uint8Array(44 + samples);
  const view = new DataView(buf.buffer);
  const a = (o: number, t: string) => {
    for (let i = 0; i < t.length; i += 1) view.setUint8(o + i, t.charCodeAt(i));
  };
  a(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  a(8, "WAVE");
  a(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  a(36, "data");
  view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i += 1) {
    view.setUint8(44 + i, 128 + Math.round(Math.sin((i / rate) * freq * 2 * Math.PI) * 100 * (1 - i / samples)));
  }
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(s)}`;
}

const GRADIENTS = [
  "linear-gradient(150deg, oklch(0.42 0.05 60), oklch(0.28 0.03 50))",
  "linear-gradient(150deg, oklch(0.55 0.06 70), oklch(0.35 0.04 55))",
  "linear-gradient(150deg, oklch(0.3 0.03 50), oklch(0.5 0.07 40))",
  "linear-gradient(150deg, oklch(0.6 0.05 80), oklch(0.4 0.05 65))",
];

const NOTES = [
  "i read your note back to you, slow.",
  "",
  "the hum from the kitchen, the night it rained.",
  "",
  "",
  "first try at saying your name.",
  "",
];

function buildGroup(prefix: string, audioCount: number, images: { at: number; gradient: string; height: number; note: string }[]): Piece[] {
  const out: Piece[] = [];
  let audioMade = 0;
  for (let pos = 0; audioMade < audioCount || images.some((im) => im.at === pos); pos += 1) {
    const img = images.find((im) => im.at === pos);
    if (img) {
      out.push({ kind: "image", id: `${prefix}-img-${pos}`, gradient: img.gradient, height: img.height, note: img.note });
      continue;
    }
    if (audioMade < audioCount) {
      const id = `${prefix}-a-${audioMade}`;
      const seed = seedFrom(id);
      out.push({
        kind: "audio",
        id,
        durationSeconds: 4 + (seed % 56),
        note: NOTES[seed % NOTES.length],
        src: tone(0.4, 240 + (seed % 200)),
      });
      audioMade += 1;
    }
  }
  return out;
}

function NotePreview({ note }: { note: string }) {
  return (
    <span className="flex items-start gap-1.5">
      <span className="mt-[0.4rem] size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
      <span className="line-clamp-1 text-left font-serif text-[0.72rem] italic leading-snug text-muted-foreground">{note}</span>
    </span>
  );
}

function AudioTile({ variant, piece }: { variant: Variant; piece: AudioPiece }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const on = () => setPlaying(true);
    const off = () => setPlaying(false);
    el.addEventListener("play", on);
    el.addEventListener("pause", off);
    el.addEventListener("ended", off);
    return () => {
      el.removeEventListener("play", on);
      el.removeEventListener("pause", off);
      el.removeEventListener("ended", off);
    };
  }, []);
  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };

  const meta = (
    <div className="mt-2 flex flex-col gap-1 px-1">
      <span className="font-serif text-sm italic leading-none text-muted-foreground tabular-nums">
        {formatDuration(piece.durationSeconds)}
      </span>
      {piece.note ? (
        <NotePreview note={piece.note} />
      ) : (
        <span className="flex items-center gap-1 font-serif text-[0.72rem] italic text-muted-foreground/60">
          <Pencil className="size-3" />
          add a note
        </span>
      )}
    </div>
  );
  const bloom = <InkBloom id={piece.id} playing={playing} onClick={toggle} />;

  return (
    <div className="mb-3 break-inside-avoid">
      <audio ref={audioRef} src={piece.src} preload="none" />
      {variant === "frameless" ? (
        <div className="flex flex-col">
          <div className="grid place-items-center py-2">{bloom}</div>
          {meta}
        </div>
      ) : variant === "soft" ? (
        <div className="df-soft-card flex flex-col rounded-3xl px-3 pb-3 pt-3">
          <div className="grid place-items-center py-1">{bloom}</div>
          {meta}
        </div>
      ) : (
        <div className="rounded-md border border-border bg-card p-2.5 shadow-xs">
          <div className="grid place-items-center py-1">{bloom}</div>
          {meta}
        </div>
      )}
    </div>
  );
}

function ImageTile({ piece }: { piece: ImagePiece }) {
  return (
    <div className="mb-3 break-inside-avoid">
      <div className="overflow-hidden rounded-md border border-border bg-card p-1 shadow-xs">
        <div className="rounded-sm" style={{ height: piece.height, background: piece.gradient }} />
      </div>
      <div className="mt-1.5 px-1">
        <span className="font-serif text-[0.7rem] italic text-muted-foreground/80">an image</span>
        {piece.note ? <NotePreview note={piece.note} /> : null}
      </div>
    </div>
  );
}

function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-4 flex items-baseline gap-3">
      <h2 className="font-serif text-lg leading-none tracking-tight text-foreground">{label}</h2>
      <span className="font-serif text-xs italic text-muted-foreground">{count} pieces</span>
      <span className="h-px flex-1 bg-border/70" aria-hidden />
    </div>
  );
}

export function GalleryAudioDrafts() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [variant, setVariant] = useState<Variant>("frameless");

  const [groups] = useState(() => [
    {
      key: "week",
      label: "earlier this week",
      pieces: buildGroup("w", 14, [
        { at: 3, gradient: GRADIENTS[0], height: 300, note: "" },
        { at: 7, gradient: GRADIENTS[2], height: 220, note: "the one that came out right." },
      ]),
    },
    {
      key: "may",
      label: "may",
      pieces: buildGroup("m", 28, [
        { at: 2, gradient: GRADIENTS[1], height: 360, note: "" },
        { at: 9, gradient: GRADIENTS[3], height: 200, note: "" },
        { at: 15, gradient: GRADIENTS[0], height: 260, note: "" },
      ]),
    },
  ]);

  return (
    <div className={cn(theme === "dark" && "dark")}>
      <DraftStyles />
      <div className="min-h-dvh bg-background text-foreground">
        <header className="sticky top-0 z-10 border-b-2 border-primary/20 bg-background/95 px-4 py-4 backdrop-blur-sm md:px-10">
          <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-serif text-2xl leading-none tracking-tight">makings · clustering test</h1>
              <p className="mt-1.5 font-serif text-xs italic text-muted-foreground">
                audio-dominant, like the real data. does the wall stay calm?
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex flex-wrap gap-1">
                {(["frameless", "soft", "boxed"] as Variant[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVariant(v)}
                    className={cn(
                      "rounded-md px-2.5 py-1 font-serif text-xs italic transition-colors",
                      variant === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
                className="rounded-md border border-border bg-card px-3 py-1 font-serif text-xs italic text-muted-foreground transition-colors hover:text-foreground"
              >
                {theme === "light" ? "dark" : "light"}
              </button>
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-6xl px-4 py-6 md:px-10">
          {groups.map((group) => (
            <section key={group.key} className="mb-10">
              <GroupHeading label={group.label} count={group.pieces.length} />
              <div className="columns-2 gap-3 sm:columns-3 lg:columns-4">
                {group.pieces.map((piece) =>
                  piece.kind === "audio" ? (
                    <AudioTile key={piece.id} variant={variant} piece={piece} />
                  ) : (
                    <ImageTile key={piece.id} piece={piece} />
                  ),
                )}
              </div>
            </section>
          ))}
          <p className="font-serif text-sm italic text-muted-foreground">
            each bloom is rotated + scaled by its id, so the wall isn't stamped. duration is the per-clip marginalia.
          </p>
        </div>
      </div>
    </div>
  );
}

function DraftStyles() {
  return (
    <style>{`
    .df { cursor: pointer; border: 0; background: transparent; isolation: isolate; }
    .df:focus-visible { outline: none; }
    .df:focus-visible .df-glyph { box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring) 55%, transparent); border-radius: 9999px; }
    .df-glyph {
      color: color-mix(in oklch, var(--primary) 78%, black);
      opacity: .45; padding: .4rem;
      transition: opacity .3s var(--ease-out-quart), transform .3s var(--ease-out-quart);
    }
    .dark .df-glyph { color: color-mix(in oklch, white 78%, var(--primary)); }
    .df:hover .df-glyph { opacity: .95; transform: scale(1.06); }

    .df-soft-card {
      background: radial-gradient(120% 90% at 50% 38%, color-mix(in oklch, var(--primary) 12%, var(--card)) 0%, var(--card) 70%);
      box-shadow: var(--shadow-xs);
    }

    .df-ink-field { position: absolute; inset: -58%; z-index: 0; pointer-events: none; filter: blur(11px); }
    .df-blob {
      position: absolute; border-radius: 9999px; opacity: .6;
      mix-blend-mode: screen; transition: opacity .5s var(--ease-out-quart); will-change: transform;
    }
    .dark .df-blob { mix-blend-mode: lighten; }
    .df-blob-a { inset: 12% 30% 32% 10%; background: radial-gradient(circle, color-mix(in oklch, var(--primary) 76%, white), transparent 68%); }
    .df-blob-b { inset: 28% 10% 14% 32%; background: radial-gradient(circle, color-mix(in oklch, var(--primary) 60%, var(--accent)), transparent 68%); }
    .df-blob-c { inset: 32% 34% 18% 18%; background: radial-gradient(circle, color-mix(in oklch, var(--primary) 54%, white), transparent 70%); }
    .df-blob-d { inset: 10% 16% 38% 36%; background: radial-gradient(circle, color-mix(in oklch, var(--primary) 64%, var(--accent)), transparent 66%); }
    .df-ink:hover .df-blob { opacity: .78; }
    .df-ink:hover .df-blob-a { animation: df-drift-a 12s ease-in-out infinite; }
    .df-ink:hover .df-blob-b { animation: df-drift-b 14s ease-in-out infinite; }
    .df-ink:hover .df-blob-c { animation: df-drift-c 16s ease-in-out infinite; }
    .df-ink:hover .df-blob-d { animation: df-drift-d 18s ease-in-out infinite; }
    .df-ink.is-playing .df-blob { opacity: .9; }
    .df-ink.is-playing .df-blob-a { animation: df-drift-a 8s ease-in-out infinite; }
    .df-ink.is-playing .df-blob-b { animation: df-drift-b 9.5s ease-in-out infinite; }
    .df-ink.is-playing .df-blob-c { animation: df-drift-c 11s ease-in-out infinite; }
    .df-ink.is-playing .df-blob-d { animation: df-drift-d 12.5s ease-in-out infinite; }

    @keyframes df-drift-a { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(13%,-10%) scale(1.13); } }
    @keyframes df-drift-b { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-12%,9%) scale(1.1); } }
    @keyframes df-drift-c { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(9%,12%) scale(.9); } }
    @keyframes df-drift-d { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-10%,-11%) scale(1.08); } }

    @media (prefers-reduced-motion: reduce) {
      .df-blob { animation: none !important; }
      .df-ink.is-playing .df-blob { opacity: .9; }
    }
    `}</style>
  );
}
