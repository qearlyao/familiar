import { useEffect, useRef, useState } from "react";
import { waveformPeaks } from "./waveformPeaks";

// Only small amplitude arrays are retained, never decoded audio buffers.
const cache = new Map<string, number[]>();

export function AudioWaveform({ url, duration, currentTime, onSeek }: {
  url: string; duration?: number; currentTime: number; onSeek: (seconds: number) => void;
}) {
  const [peaks, setPeaks] = useState<number[] | undefined>(() => cache.get(url));
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const progress = duration ? Math.min(1, Math.max(0, currentTime / duration)) : 0;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        let next = cache.get(url);
        if (!next) {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) throw new Error(`Audio request returned ${response.status}`);
          const bytes = await response.arrayBuffer();
          if (controller.signal.aborted) return;
          const context = new OfflineAudioContext(1, 1, 8000);
          const audio = await context.decodeAudioData(bytes);
          if (controller.signal.aborted) return;
          next = waveformPeaks(Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i)));
          if (cache.size >= 24) cache.delete(cache.keys().next().value!);
          cache.set(url, next);
        }
        if (!controller.signal.aborted) { setPeaks(next); setError(undefined); }
      } catch (cause) {
        if (controller.signal.aborted) return;
        console.error("[makings.waveform] Could not decode recording", { url, cause });
        setError("waveform unavailable");
      }
    }
    void load();
    return () => controller.abort();
  }, [url, attempt]);

  useEffect(() => {
    const element = canvas.current;
    if (!element || !peaks) return;
    const draw = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      const scale = window.devicePixelRatio || 1;
      element.width = Math.round(width * scale);
      element.height = Math.round(height * scale);
      const context = element.getContext("2d");
      if (!context) return;
      context.scale(scale, scale);
      const step = width / peaks.length;
      const bars = (color: string) => {
        context.fillStyle = color;
        peaks.forEach((peak, i) => {
          const h = Math.max(2, peak * (height - 5));
          context.fillRect(i * step, height - h - 2, Math.max(1, step * 0.58), h);
        });
      };
      bars("#92947a");
      context.save();
      context.beginPath();
      context.rect(0, 0, width * progress, height);
      context.clip();
      bars("#ddc590");
      context.restore();
      context.fillStyle = "#ddc590";
      context.fillRect(0, height - 2, width * progress, 1);
      if (duration) {
        context.beginPath();
        context.arc(Math.max(4, Math.min(width - 4, width * progress)), height - 4, 4, 0, 2 * Math.PI);
        context.fill();
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    return () => observer.disconnect();
  }, [peaks, progress, duration]);

  return <div className="makings-waveform">
    {peaks ? <>
      <canvas ref={canvas} aria-hidden="true" />
      <input type="range" min={0} max={duration ?? 0} step={0.1}
        value={Math.min(currentTime, duration ?? 0)} disabled={!duration}
        onChange={(event) => onSeek(Number(event.target.value))} aria-label="seek recording" />
    </> : error ? <button type="button" className="makings-waveform-status" onClick={() => { setError(undefined); setAttempt((n) => n + 1); }} title="retry waveform">{error} · retry</button>
      : <span role="status" className="makings-waveform-status">reading the sound…</span>}
  </div>;
}
