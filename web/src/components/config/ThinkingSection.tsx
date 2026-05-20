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
        spacing={1}
        className="mt-4 flex-wrap rounded-lg bg-muted/40 p-1"
      >
        {options.map((level) => (
          <ToggleGroupItem
            key={level}
            value={level}
            aria-label={`thinking ${level}`}
            className="h-9 rounded-md px-3.5 text-sm lowercase text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary"
          >
            {level}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </section>
  );
}
