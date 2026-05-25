import type { Message } from "../types";
import { chunkSteps } from "@/lib/chunkSteps";
import { EventStream } from "./EventStream";
import { TextStep } from "./steps/TextStep";

export function TurnView({ message }: { message: Message }) {
  const { steps, silent, who } = message;
  const chunks = chunkSteps(steps);
  const firstTextIdx = chunks.findIndex((c) => c.kind === "text");
  const hasText = firstTextIdx >= 0;
  const showTopLabel = silent === true && !hasText && Boolean(who);

  return (
    <div className="flex w-full flex-col gap-1">
      {showTopLabel && (
        <span className="block text-xs uppercase tracking-wider text-muted-foreground">
          {who}
        </span>
      )}
      {chunks.map((chunk, i) => {
        if (chunk.kind === "stream") {
          return <EventStream key={`stream-${i}`} steps={chunk.steps} />;
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
        <div className="mt-2 flex justify-center">
          <p className="font-serif italic text-xs text-muted-foreground/70">
            they kept quiet
          </p>
        </div>
      )}
    </div>
  );
}
