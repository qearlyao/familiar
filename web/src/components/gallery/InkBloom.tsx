import type { CSSProperties } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";

type BloomPulse = "low" | "middle" | "bright";

function bloomSeed(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function bloomFieldStyle(id: string, scaleOffset = 0): CSSProperties {
  const seed = bloomSeed(id);
  const rotation = seed % 360;
  const scale = 0.9 + scaleOffset + ((seed >> 4) % 24) / 100;
  return { transform: `rotate(${rotation}deg) scale(${scale})` };
}

export function bloomPulseForId(id: string): BloomPulse {
  const bucket = bloomSeed(id) % 3;
  if (bucket === 0) return "low";
  if (bucket === 1) return "middle";
  return "bright";
}

export function InkBloomField({
  id,
  playing,
  className,
  pulse = "middle",
  scaleOffset,
}: {
  id: string;
  playing: boolean;
  className?: string;
  pulse?: BloomPulse;
  scaleOffset?: number;
}) {
  return (
    <span
      className={cn(
        "bloom pointer-events-none rounded-full",
        pulse === "bright" && "opacity-95",
        pulse === "low" && "opacity-75",
        playing && "is-playing",
        className,
      )}
      aria-hidden
    >
      <span className="bloom-field" style={bloomFieldStyle(id, scaleOffset)}>
        <span className="bloom-blob bloom-blob-a" />
        <span className="bloom-blob bloom-blob-b" />
        <span className="bloom-blob bloom-blob-c" />
        <span className="bloom-blob bloom-blob-d" />
      </span>
    </span>
  );
}

export function InkBloom({
  id,
  playing,
  onToggle,
}: {
  id: string;
  playing: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={playing ? "pause recording" : "play recording"}
      className={cn("bloom group/bloom size-20", playing && "is-playing")}
    >
      <span className="bloom-field" style={bloomFieldStyle(id)} aria-hidden>
        <span className="bloom-blob bloom-blob-a" />
        <span className="bloom-blob bloom-blob-b" />
        <span className="bloom-blob bloom-blob-c" />
        <span className="bloom-blob bloom-blob-d" />
      </span>
      <span className="bloom-glyph">
        {playing ? (
          <Pause className="size-5 fill-current" strokeWidth={0} />
        ) : (
          <Play className="size-5 translate-x-px fill-current" strokeWidth={0} />
        )}
      </span>
    </button>
  );
}
