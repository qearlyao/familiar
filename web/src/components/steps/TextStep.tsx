import { renderInlineText } from "@/lib/renderInlineText";
import type { TextStep as TextStepData } from "../../types";

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
  return (
    <div className="flex w-full flex-col">
      {showLabel && who && (
        <span className="mt-2 mb-1 block text-xs uppercase tracking-wider text-muted-foreground">
          {who}
        </span>
      )}
      {renderInlineText(step.text, { trailingCursor: active })}
    </div>
  );
}
