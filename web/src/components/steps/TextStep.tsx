import { renderInlineText } from "@/lib/renderInlineText";
import {
  hasSilentMarker,
  stripStreamingTail,
  withoutSilentMarker,
} from "@/lib/silentMarker";
import type { TextStep as TextStepData } from "../../types";

export function TextStep({
  step,
  silent,
}: {
  step: TextStepData;
  silent?: boolean;
}) {
  const active = !step.complete;
  const isSilent = silent === true || hasSilentMarker(step.text);
  const text = isSilent
    ? withoutSilentMarker(active ? stripStreamingTail(step.text) : step.text)
    : step.text;
  return (
    <div className="flex w-full flex-col">
      {isSilent ? (
        <div className="font-serif italic text-sm leading-relaxed text-muted-foreground/70">
          {renderInlineText(text, { trailingCursor: active })}
        </div>
      ) : (
        renderInlineText(text, { trailingCursor: active })
      )}
    </div>
  );
}
