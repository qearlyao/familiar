import type { Step, ThinkingStep, ToolStep } from "../types";
import { stripStreamingTail, withoutSilentMarker } from "./silentMarker";

export type GutterStep = ThinkingStep | ToolStep;

export type StepChunk =
  | { kind: "stream"; steps: GutterStep[] }
  | { kind: "text"; step: Extract<Step, { kind: "text" }> }
  | { kind: "error"; step: Extract<Step, { kind: "error" }> };

export function chunkSteps(steps: Step[]): StepChunk[] {
  const out: StepChunk[] = [];
  let pending: GutterStep[] = [];
  const flush = () => {
    if (pending.length > 0) {
      out.push({ kind: "stream", steps: pending });
      pending = [];
    }
  };
  for (const step of steps) {
    if (step.kind === "text") {
      // marker-only text renders to nothing; don't let it split a stream group
      const visible = withoutSilentMarker(step.complete ? step.text : stripStreamingTail(step.text));
      if (!visible) continue;
      flush();
      out.push({ kind: "text", step });
    } else if (step.kind === "error") {
      flush();
      out.push({ kind: "error", step });
    } else {
      pending.push(step);
    }
  }
  flush();
  return out;
}
