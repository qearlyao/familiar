import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ThinkingLevel } from "@/lib/api";

interface ThinkingSectionProps {
  current: ThinkingLevel | undefined;
  supported: ThinkingLevel[];
  disabled: boolean;
  onChange: (level: ThinkingLevel) => void;
}

const LEVEL_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function ThinkingSection({ current, supported, disabled, onChange }: ThinkingSectionProps) {
  const visible = LEVEL_ORDER.filter((level) => supported.includes(level));
  const options = visible.length > 0 ? visible : LEVEL_ORDER;
  return (
    <section>
      <h3 className="font-serif text-lg leading-tight tracking-tight text-foreground">thinking</h3>
      <p className="mt-1 font-serif text-xs italic text-muted-foreground">
        how long the model deliberates before answering.
      </p>
      <ToggleGroup
        type="single"
        value={current ?? ""}
        onValueChange={(value) => {
          if (value) onChange(value as ThinkingLevel);
        }}
        disabled={disabled}
        variant="outline"
        size="sm"
        className="mt-3 w-full"
      >
        {options.map((level) => (
          <ToggleGroupItem
            key={level}
            value={level}
            aria-label={`thinking ${level}`}
            className="flex-1 lowercase"
          >
            {level}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </section>
  );
}
