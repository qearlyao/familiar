import { useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { cn } from "@/lib/utils";
import { IconDownload, IconPause, IconPlay, IconX } from "./organicIcons";
import { focusPanel } from "@/lib/focusPanel";

export type PreviewMedia = { src: string; name: string; kind: "image" | "video" };

function time(value: number) {
  const seconds = Math.floor(Number.isFinite(value) ? value : 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function IconStep({ back }: { back?: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={back ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}

function IconSound({ muted, size = 17 }: { muted: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5L6.5 9H3v6h3.5L11 19z" />
      {muted ? <path d="M16 10l5 5M21 10l-5 5" /> : <><path d="M16 9.5a3.5 3.5 0 0 1 0 5" /><path d="M18.8 6.5a7.5 7.5 0 0 1 0 11" /></>}
    </svg>
  );
}

/** The picture and, for a clip, the transport that sits under it — never over it. */
function Stage({ item, onBare }: { item: PreviewMedia; onBare: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string>();

  function report(message: string, cause?: unknown) {
    console.error("[media-viewer]", { kind: item.kind, name: item.name, message, cause });
    setError(message);
  }
  async function togglePlay() {
    const el = video.current;
    if (!el) return;
    if (!el.paused) el.pause();
    else {
      try {
        await el.play();
        setError(undefined);
      } catch (cause) {
        report("Couldn't play this clip. Try again, or download the original.", cause);
      }
    }
  }

  return (
    <div className="viewer-stage">
      <div className="viewer-frame">
        {item.kind === "video" ? (
          <video
            ref={video}
            src={item.src}
            playsInline
            preload="metadata"
            aria-label={item.name}
            onClick={() => void togglePlay()}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
            onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
            onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
            onError={(event) => report("Couldn't load this clip. Download the original to open it elsewhere.", event.currentTarget.error?.code)}
          />
        ) : (
          <img src={item.src} alt={item.name} onClick={onBare} onError={() => report("Couldn't load this picture. Try opening the original.")} />
        )}
      </div>
      {error && <p className="viewer-error" role="alert">{error}</p>}
      {item.kind === "video" && (
        <div className="viewer-transport">
          <button type="button" className="viewer-accent is-round" onClick={() => void togglePlay()} aria-label={playing ? "pause" : "play"}>
            {playing ? <IconPause size={19} /> : <IconPlay size={19} />}
          </button>
          <span className="viewer-scrub">
            <input
              type="range"
              aria-label="seek"
              min={0}
              max={duration || 0}
              step={0.1}
              value={position}
              disabled={!duration}
              onChange={(event) => {
                if (!video.current) return;
                video.current.currentTime = Number(event.target.value);
                setPosition(Number(event.target.value));
              }}
              style={{ backgroundSize: `${duration ? (position / duration) * 100 : 0}% 100%` }}
            />
            <span className="viewer-times">
              <span>{time(position)}</span>
              <span>{time(duration)}</span>
            </span>
          </span>
          <button type="button" className="viewer-ghost" aria-label={muted ? "sound on" : "sound off"} onClick={() => { if (video.current) video.current.muted = !video.current.muted; }}>
            <IconSound muted={muted} />
          </button>
        </div>
      )}
    </div>
  );
}

export function MediaPreview({ src, alt, className, imageClassName, kind = "image", items }: {
  src: string; alt: string; className?: string; imageClassName?: string; kind?: "image" | "video"; items?: PreviewMedia[];
}) {
  const [selected, setSelected] = useState(src);
  const [bare, setBare] = useState(false);
  const closedByKey = useRef(false);
  const media = items?.length ? items : [{ src, name: alt, kind }];
  const index = Math.max(0, media.findIndex((item) => item.src === selected));
  const current = media[index];
  const move = (delta: number) => setSelected(media[(index + delta + media.length) % media.length].src);

  return (
    <Dialog.Root onOpenChange={(open) => { if (open) { setSelected(src); setBare(false); } }}>
      <Dialog.Trigger asChild>
        <button type="button" aria-label={`open ${alt}`} className={cn("media-preview-trigger inline-block w-fit max-w-full rounded-md text-left outline-none transition-opacity hover:opacity-90 sm:max-w-[24rem]", className)}>
          {kind === "image" ? (
            <img src={src} alt={alt} loading="lazy" className={cn("h-auto max-h-72 max-w-full rounded-md", imageClassName)} />
          ) : (
            <>
              <video src={src} preload="metadata" muted playsInline aria-hidden="true" />
              <span className="media-preview-play"><IconPlay size={24} /> <span>watch clip</span></span>
              <span className="chat-media-name">{alt}</span>
            </>
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="viewer-overlay" />
        <Dialog.Content
          className="viewer chat-theme"
          data-bare={bare || undefined}
          aria-describedby={undefined}
          onOpenAutoFocus={focusPanel}
          onCloseAutoFocus={(event) => {
            if (!closedByKey.current) event.preventDefault();
            closedByKey.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") closedByKey.current = true;
            if (event.target instanceof HTMLInputElement) return;
            if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
            if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
          }}
        >
          <header className="viewer-head">
            <Dialog.Close className="viewer-ghost viewer-close-top" aria-label="back to the thread"><IconX size={18} /></Dialog.Close>
            <span className="viewer-title">
              <Dialog.Title title={current.name}>{current.name}</Dialog.Title>
              <p>{current.kind === "video" ? "a clip" : "a picture"}{media.length > 1 ? ` · ${index + 1} of ${media.length}` : ""}</p>
            </span>
          </header>

          <div className="viewer-actions">
            <a className="viewer-accent" href={current.src} download={current.name} title="download the original">
              <IconDownload size={16} /> download
            </a>
            <Dialog.Close className="viewer-ghost viewer-close-side" aria-label="close"><IconX size={18} /></Dialog.Close>
          </div>

          <div className="viewer-body">
            {media.length > 1 && (
              <button type="button" className="viewer-ghost viewer-step" onClick={() => move(-1)} aria-label="previous">
                <IconStep back />
              </button>
            )}
            <Stage key={current.src} item={current} onBare={() => setBare((was) => !was)} />
            {media.length > 1 && (
              <button type="button" className="viewer-ghost viewer-step is-next" onClick={() => move(1)} aria-label="next">
                <IconStep />
              </button>
            )}
          </div>

          {bare && (
            <button type="button" className="viewer-hint" onClick={() => setBare(false)}>tap once to bring it all back</button>
          )}

          {media.length > 1 && (
            <nav className="viewer-strip" aria-label="everything sent together">
              {media.map((item, itemIndex) => (
                <button key={item.src} type="button" aria-label={`view ${item.name}`} aria-current={itemIndex === index ? "true" : undefined} onClick={() => setSelected(item.src)}>
                  {item.kind === "image" ? <img src={item.src} alt="" loading="lazy" /> : <><video src={item.src} preload="metadata" muted playsInline aria-hidden="true" /><IconPlay size={14} /></>}
                </button>
              ))}
            </nav>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
