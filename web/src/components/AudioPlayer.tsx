import { useRef, useState } from "react";
import { mmss } from "@/lib/clock";
import { IconPause, IconPlay } from "./organicIcons";

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

  const onMeta = (event: React.SyntheticEvent<HTMLAudioElement>) =>
    setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);

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
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onLoadedMetadata={onMeta}
        onDurationChange={onMeta}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      >
        <a href={src}>{name ?? "audio"}</a>
      </audio>
      <button type="button" className="chat-audio-play" onClick={toggle} aria-label={playing ? "pause" : "play"}>
        {playing ? <IconPause size={17} /> : <IconPlay size={19} />}
      </button>
      <div className="chat-audio-wave" style={{ width }}>
        <input type="range" aria-label="seek" min={0} max={duration || 0} step={0.1} value={currentTime} onChange={(event) => seek(Number(event.target.value))} />
        {Array.from({ length: Math.round(width / 6) }, (_, i) => (
          <span
            key={i}
            className={i / Math.round(width / 6) < pct ? "on" : undefined}
            style={{ height: `${BARS[i % BARS.length] * 100}%` }}
          />
        ))}
      </div>
      <span className="chat-audio-time">{mmss(playing ? currentTime : duration)}</span>
    </div>
  );
}
