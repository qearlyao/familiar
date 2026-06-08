import type { CSSProperties } from "react";

export type BloomPulse = "low" | "middle" | "bright";

function bloomSeed(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

export function bloomFieldStyle(id: string, scaleOffset = 0): CSSProperties {
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
