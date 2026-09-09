import type { ThinkingLevel } from "@/lib/api";
import { THINKING_ORDER } from "@/lib/thinkingLevels";

export function ThinkingSection({
  current,
  supported,
  disabled,
  onChange,
}: {
  current: ThinkingLevel | undefined;
  supported: ThinkingLevel[];
  disabled: boolean;
  onChange: (level: ThinkingLevel) => void;
}) {
  const visible = THINKING_ORDER.filter((level) => supported.includes(level));
  const options = visible.length > 0 ? visible : THINKING_ORDER;
  return (
    <div className="seg" role="group" aria-label="thinking">
      {options.map((level) => (
        <button key={level} type="button" className="seg-pill" aria-pressed={level === current} disabled={disabled} onClick={() => onChange(level)}>
          {level}
        </button>
      ))}
    </div>
  );
}
