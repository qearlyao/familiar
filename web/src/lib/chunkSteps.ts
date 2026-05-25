import type { Step, ThinkingStep, ToolStep } from "../types";

export type GutterStep = ThinkingStep | ToolStep;

export type StepChunk =
  | { kind: "stream"; steps: GutterStep[] }
  | { kind: "text"; step: Extract<Step, { kind: "text" }> };

export function chunkSteps(steps: Step[]): StepChunk[] {
  const out: StepChunk[] = [];
  let pending: GutterStep[] = [];
  for (const step of steps) {
    if (step.kind === "text") {
      if (pending.length > 0) {
        out.push({ kind: "stream", steps: pending });
        pending = [];
      }
      out.push({ kind: "text", step });
    } else {
      pending.push(step);
    }
  }
  if (pending.length > 0) out.push({ kind: "stream", steps: pending });
  return out;
}
