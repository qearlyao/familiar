import type { ThinkingLevel } from "@/lib/api";
import { THINKING_ORDER } from "@/lib/thinkingLevels";
import { Card, EnumToggle } from "./inputs";

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
  const options = (visible.length > 0 ? visible : THINKING_ORDER).map((level) => ({ value: level, label: level }));
  return (
    <Card title="thinking" hint="how long they deliberate before answering." bare>
      <EnumToggle value={current} options={options} ariaPrefix="thinking" disabled={disabled} onChange={onChange} />
    </Card>
  );
}
