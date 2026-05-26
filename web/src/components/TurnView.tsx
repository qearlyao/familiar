import type { Message, Step } from "../types";
import { chunkSteps } from "@/lib/chunkSteps";
import { EventStream } from "./EventStream";
import { TextStep } from "./steps/TextStep";

function isStepFinished(step: Step): boolean {
  if (step.kind === "thinking") return step.complete === true;
  if (step.kind === "text") return step.complete === true;
  return step.tool.status === "completed" || step.tool.status === "error";
}

export function TurnView({ message }: { message: Message }) {
  const { steps, silent, who } = message;
  const chunks = chunkSteps(steps);
  const firstTextIdx = chunks.findIndex((c) => c.kind === "text");
  const hasText = firstTextIdx >= 0;
  const showTopLabel = silent === true && !hasText && Boolean(who);
  const messageSettled =
    steps.length > 0 && steps.every(isStepFinished) && (silent === true || hasText);

  return (
    <div className="flex w-full flex-col gap-1">
      {showTopLabel && (
        <span className="mt-2 mb-1 block text-xs uppercase tracking-wider text-muted-foreground">
          {who}
        </span>
      )}
      {chunks.map((chunk, i) => {
        if (chunk.kind === "stream") {
          return (
            <EventStream
              key={`stream-${i}`}
              steps={chunk.steps}
              autoCollapse={messageSettled}
            />
          );
        }
        const prev = chunks[i - 1];
        const showLabel = !prev || prev.kind !== "text";
        return (
          <TextStep
            key={chunk.step.id}
            step={chunk.step}
            who={who}
            showLabel={showLabel}
          />
        );
      })}
      {silent && !hasText && (
        <p className="font-serif italic text-sm leading-relaxed text-muted-foreground/70">
          they kept quiet.
        </p>
      )}
    </div>
  );
}
