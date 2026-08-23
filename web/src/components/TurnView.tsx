import type { Message } from "../types";
import { chunkSteps } from "@/lib/chunkSteps";
import { EventStream } from "./EventStream";
import { ErrorNotice } from "./steps/ErrorNotice";
import { withoutSilentMarker } from "@/lib/silentMarker";
import { TextStep } from "./steps/TextStep";

export function TurnView({ message }: { message: Message }) {
  const { steps, silent, who } = message;
  const chunks = chunkSteps(steps);
  const hasText = chunks.some(
    (c) => c.kind === "text" && withoutSilentMarker(c.step.text),
  );
  const showTopLabel = silent === true && !hasText && Boolean(who);

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
            <EventStream key={`stream-${i}`} steps={chunk.steps} />
          );
        }
        if (chunk.kind === "error") {
          return <ErrorNotice key={chunk.step.id} text={chunk.step.text} />;
        }
        const prev = chunks[i - 1];
        const showLabel = !prev || prev.kind !== "text";
        return (
          <TextStep
            key={chunk.step.id}
            step={chunk.step}
            who={who}
            showLabel={showLabel}
            silent={silent}
          />
        );
      })}
      {silent && (
        <p className="font-serif italic text-sm leading-relaxed text-muted-foreground/70">
          they kept quiet.
        </p>
      )}
    </div>
  );
}
