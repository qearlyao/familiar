import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ThinkingLevel } from "@/lib/api";
import { cn } from "@/lib/utils";

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
  const columns = options.length <= 1 ? "grid-cols-1" : options.length === 2 ? "grid-cols-2" : "grid-cols-3";
  return (
    <ToggleGroup
      type="single"
      value={current ?? ""}
      onValueChange={(value) => {
        if (value) onChange(value as ThinkingLevel);
      }}
      disabled={disabled}
      className={cn("grid w-full items-stretch gap-1 rounded-md bg-muted/40 p-1", columns)}
    >
      {options.map((level) => (
        <ToggleGroupItem
          key={level}
          value={level}
          aria-label={`thinking ${level}`}
          className="h-8 w-full justify-center rounded-sm px-2 font-mono text-xs lowercase text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary"
        >
          {level}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
