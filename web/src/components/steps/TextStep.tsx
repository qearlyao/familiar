import { renderInlineText } from "@/lib/renderInlineText";
import type { TextStep as TextStepData } from "../../types";

const SILENT_MARKER = "[[FAMILIAR_SILENT]]";

export function TextStep({
  step,
  who,
  showLabel,
}: {
  step: TextStepData;
  who: string;
  showLabel: boolean;
}) {
  const active = !step.complete;
  const isSilent = step.text.startsWith(SILENT_MARKER);
  return (
    <div className="flex w-full flex-col">
      {showLabel && who && (
        <span className="mt-2 mb-1 block text-xs uppercase tracking-wider text-muted-foreground">
          {who}
        </span>
      )}
      {isSilent ? (
        <p className="font-serif italic text-sm leading-relaxed text-muted-foreground/70">
          they kept quiet.
        </p>
      ) : (
        renderInlineText(step.text, { trailingCursor: active })
      )}
    </div>
  );
}
