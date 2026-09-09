import { useEffect, useRef, useState } from "react";
import { IconPause, IconPlay } from "./organicIcons";

function format(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

// Bar heights from the mock-up waveform, as fractions of the 34px track.
const BARS = [
  8, 14, 22, 12, 26, 18, 10, 24, 30, 16, 8, 20, 28, 14, 10, 18, 26, 12, 8, 22,
  30, 18, 12, 24, 16, 6, 14, 28, 20, 10, 18, 8, 24, 14, 22, 12, 6, 16,
].map((h) => h / 34);

// Spec widths by duration: 0:07 → 122px, 0:41 → 182px, 3:12 → 232px.
function trackWidth(duration: number): number {
  if (duration <= 0) return 182;
  if (duration < 20) return 122;
  if (duration < 120) return 182;
  return 232;
}

export function AudioPlayer({ src, name }: { src: string; name?: string }) {
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
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
    };
  }, []);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) el.pause();
    else void el.play();
  };

  const seek = (time: number) => {
    const el = audioRef.current;
    if (!el || !Number.isFinite(time)) return;
    el.currentTime = Math.min(Math.max(time, 0), duration);
    setCurrentTime(el.currentTime);
  };

  const pct = duration > 0 ? currentTime / duration : 0;
  const width = trackWidth(duration);

  return (
    <div className="chat-audio">
      <audio ref={audioRef} src={src} preload="metadata">
        <a href={src}>{name ?? "audio"}</a>
      </audio>
      <button type="button" className="chat-audio-play" onClick={toggle} aria-label={playing ? "pause" : "play"}>
        {playing ? <IconPause size={15} /> : <IconPlay size={15} />}
      </button>
      <div
        className="chat-audio-wave"
        style={{ width }}
        role="slider"
        tabIndex={0}
        aria-label="seek"
        aria-valuemin={0}
        aria-valuemax={duration || 0}
        aria-valuenow={currentTime}
        onKeyDown={(event) => {
          const step = event.key === "ArrowLeft" ? -5 : event.key === "ArrowRight" ? 5 : 0;
          if (!step) return;
          seek(currentTime + step);
        }}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          seek(((event.clientX - box.left) / box.width) * duration);
        }}
      >
        {Array.from({ length: Math.round(width / 6) }, (_, i) => (
          <span
            key={i}
            className={i / Math.round(width / 6) < pct ? "on" : undefined}
            style={{ height: `${BARS[i % BARS.length] * 100}%` }}
          />
        ))}
      </div>
      <span className="chat-audio-time">{format(playing ? currentTime : duration)}</span>
    </div>
  );
}
