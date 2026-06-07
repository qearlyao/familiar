import type { CSSProperties } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";

function bloomFieldStyle(id: string): CSSProperties {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const seed = Math.abs(hash);
  const rotation = seed % 360;
  const scale = 0.86 + ((seed >> 4) % 30) / 100;
  return { transform: `rotate(${rotation}deg) scale(${scale})` };
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
