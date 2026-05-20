import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";

function format(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioPlayer({
  src,
  name,
  className,
}: {
  src: string;
  name?: string;
  className?: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrentTime(el.currentTime);
    const onMeta = () => setDuration(Number.isFinite(el.duration) ? el.duration : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnd = () => setPlaying(false);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnd);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnd);
    };
  }, []);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) el.pause();
    else void el.play();
  };

  const seek = (next: number) => {
    const el = audioRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(duration || 0, next));
    el.currentTime = clamped;
    setCurrentTime(clamped);
  };

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      className={cn(
        "flex w-full max-w-sm items-center gap-3 rounded-md bg-card px-3 py-2",
        className,
      )}
    >
      <audio ref={audioRef} src={src} preload="metadata">
        <a href={src}>{name ?? "audio"}</a>
      </audio>
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "pause" : "play"}
        className="grid size-8 shrink-0 place-items-center rounded-md text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
      >
        {playing ? (
          <Pause className="size-4 fill-current" strokeWidth={0} />
        ) : (
          <Play className="size-4 fill-current translate-x-px" strokeWidth={0} />
        )}
      </button>
      <span className="shrink-0 whitespace-nowrap font-serif text-xs italic text-muted-foreground tabular-nums">
        {format(currentTime)} / {format(duration)}
      </span>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={currentTime}
        onChange={(event) => seek(Number(event.target.value))}
        aria-label="seek"
        className={cn(
          "h-1 flex-1 cursor-pointer appearance-none rounded-full bg-border outline-none",
          "[&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:cursor-pointer",
          "[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:cursor-pointer",
          "focus-visible:ring-3 focus-visible:ring-ring/40",
        )}
        style={{
          background: `linear-gradient(to right, var(--primary) 0%, var(--primary) ${pct}%, var(--border) ${pct}%, var(--border) 100%)`,
        }}
      />
    </div>
  );
}
