import { renderInlineText } from "@/lib/renderInlineText";
import {
  hasSilentMarker,
  stripStreamingTail,
  withoutSilentMarker,
} from "@/lib/silentMarker";
import type { TextStep as TextStepData } from "../../types";

export function TextStep({
  step,
  who,
  showLabel,
  silent,
}: {
  step: TextStepData;
  who: string;
  showLabel: boolean;
  silent?: boolean;
}) {
  const active = !step.complete;
  const isSilent = silent === true || hasSilentMarker(step.text);
  const text = isSilent
    ? withoutSilentMarker(active ? stripStreamingTail(step.text) : step.text)
    : step.text;
  return (
    <div className="flex w-full flex-col">
      {showLabel && who && (
        <span className="mt-2 mb-1 block text-xs uppercase tracking-wider text-muted-foreground">
          {who}
        </span>
      )}
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
