import type { ReactNode } from "react";
import type { Message } from "../types";
import { chunkSteps, type StepChunk } from "@/lib/chunkSteps";
import { EventStream } from "./EventStream";
import { ErrorNotice } from "./steps/ErrorNotice";
import { TextStep } from "./steps/TextStep";

type BodyChunk = Exclude<StepChunk, { kind: "stream" }>;
type Block = { kind: "stream"; steps: Extract<StepChunk, { kind: "stream" }>["steps"] } | { kind: "body"; chunks: BodyChunk[] };

/** Step groups sit outside the speaker block, as their own row (see mockup). */
function blocksOf(chunks: StepChunk[]): Block[] {
  const out: Block[] = [];
  for (const chunk of chunks) {
    if (chunk.kind === "stream") {
      out.push({ kind: "stream", steps: chunk.steps });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === "body") last.chunks.push(chunk);
    else out.push({ kind: "body", chunks: [chunk] });
  }
  return out;
}

export function TurnView({ message, children }: { message: Message; children?: ReactNode }) {
  const { steps, silent, who } = message;
  const blocks = blocksOf(chunkSteps(steps));
  if (children && !blocks.some((b) => b.kind === "body")) blocks.push({ kind: "body", chunks: [] });
  const lastBody = blocks.findLastIndex((b) => b.kind === "body");

  return (
    <>
      {blocks.map((block, i) =>
        block.kind === "stream" ? (
          <div key={`stream-${i}`} className="chat-turn-steps">
            <EventStream steps={block.steps} />
          </div>
        ) : (
          <div key={`body-${i}`} className="chat-assistant-turn">
            {who && <span className="chat-speaker">{who}</span>}
            {block.chunks.map((chunk) =>
              chunk.kind === "error" ? (
                <ErrorNotice key={chunk.step.id} text={chunk.step.text} />
              ) : (
                <TextStep key={chunk.step.id} step={chunk.step} silent={silent} />
              ),
            )}
            {i === lastBody && children}
          </div>
        ),
      )}
    </>
  );
}
