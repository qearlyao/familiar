import type { ContextBreakdown } from "../../../src/web/types.js";

export type { ContextBreakdown };

export const CONTEXT_SEGMENTS = [
  { key: "other", label: "system, tools & memories", color: "#2B1901" },
  { key: "summaries", label: "kept as summaries", color: "#4C3E2C" },
  { key: "pending", label: "waiting to be summarised", color: "#D6BD8A" },
  { key: "fresh", label: "fresh tail, kept whole", color: "#525833" },
] as const;

// Estimates determine proportions; only model-reported usage determines the total.
export function contextSegments(tokens: number, breakdown?: ContextBreakdown) {
  if (!breakdown) return [];
  const weights = CONTEXT_SEGMENTS.map(({ key }) => breakdown[key]);
  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new Error("Invalid context breakdown: weights must be finite and nonnegative");
  }
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight === 0) return [];
  let cumulativeWeight = 0;
  let allocated = 0;
  return CONTEXT_SEGMENTS.map((segment, index) => {
    cumulativeWeight += weights[index];
    const cumulativeTokens = Math.round(tokens * cumulativeWeight / totalWeight);
    const count = cumulativeTokens - allocated;
    const start = allocated;
    allocated = cumulativeTokens;
    return { ...segment, tokens: count, start };
  });
}
