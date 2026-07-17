import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useCommittedInput } from "./useCommittedInput";

const toggleClass =
  "h-9 rounded-md px-3.5 text-sm lowercase text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary";

export function OnOffToggle({
  enabled,
  disabled,
  ariaPrefix,
  onChange,
}: {
  enabled: boolean | undefined;
  disabled: boolean;
  ariaPrefix: string;
  onChange: (next: boolean) => void;
}) {
  const isOn = enabled === true;
  return (
    <ToggleGroup
      type="single"
      value={enabled === undefined ? "" : isOn ? "on" : "off"}
      onValueChange={(value) => {
        if (value) onChange(value === "on");
      }}
      disabled={disabled}
      spacing={1}
      className="rounded-lg bg-muted/40 p-1"
    >
      <ToggleGroupItem value="on" aria-label={`${ariaPrefix} on`} className={toggleClass}>
        on
      </ToggleGroupItem>
      <ToggleGroupItem value="off" aria-label={`${ariaPrefix} off`} className={toggleClass}>
        off
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

const MS_PER_MIN = 60_000;

export function MinuteInput({
  valueMs,
  disabled,
  onCommit,
}: {
  valueMs: number | undefined;
  disabled: boolean;
  onCommit: (ms: number) => Promise<void>;
}) {
  const minutes = valueMs === undefined ? "" : String(Math.round(valueMs / MS_PER_MIN));
  const field = useCommittedInput(
    minutes,
    (draft) => {
      const parsed = Number.parseInt(draft, 10);
      if (Number.isNaN(parsed) || parsed < 1) return "reset";
      const ms = parsed * MS_PER_MIN;
      return ms === valueMs ? "reset" : { value: ms };
    },
    onCommit,
  );

  return (
    <input
      {...field.inputProps}
      type="number"
      inputMode="numeric"
      disabled={disabled || field.busy}
      min={1}
      className="h-8 w-16 rounded-md border border-border bg-background px-2 font-mono text-sm text-right text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
    />
  );
}

export function NumberInput({
  value,
  step = 1,
  min,
  max,
  disabled,
  onCommit,
}: {
  value: number | undefined;
  step?: number;
  min?: number;
  max?: number;
  disabled: boolean;
  onCommit: (v: number) => Promise<void>;
}) {
  const live = value === undefined ? "" : String(value);
  const field = useCommittedInput(
    live,
    (draft) => {
      const parsed = Number(draft);
      if (!Number.isFinite(parsed)) return "reset";
      if (min !== undefined && parsed < min) return "reset";
      if (max !== undefined && parsed > max) return "reset";
      return parsed === value ? "reset" : { value: parsed };
    },
    onCommit,
  );

  return (
    <input
      {...field.inputProps}
      type="number"
      inputMode={step < 1 ? "decimal" : "numeric"}
      disabled={disabled || field.busy}
      step={step}
      min={min}
      max={max}
      className="h-8 w-20 rounded-md border border-border bg-background px-2 font-mono text-sm text-right text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
    />
  );
}

interface TextInputProps {
  value: string | undefined;
  placeholder?: string;
  allowEmpty?: boolean;
  pattern?: RegExp;
  disabled: boolean;
  onCommit: (next: string) => Promise<void>;
}

export function TextInput({
  value,
  placeholder,
  allowEmpty = false,
  pattern,
  disabled,
  onCommit,
}: TextInputProps) {
  const live = value ?? "";
  const field = useCommittedInput(
    live,
    (draft) => {
      const trimmed = draft.trim();
      if (trimmed === live) return "reset";
      if (!trimmed) return allowEmpty ? { value: "" } : pattern ? "reset" : "invalid";
      if (pattern && !pattern.test(trimmed)) return "invalid";
      return { value: trimmed };
    },
    onCommit,
  );

  return (
    <input
      {...field.inputProps}
      type="text"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      placeholder={placeholder}
      disabled={disabled || field.busy}
      aria-invalid={field.invalid || undefined}
      className={`h-9 w-full rounded-md border bg-background px-3 font-mono text-sm text-foreground focus-visible:ring-3 focus-visible:outline-none disabled:opacity-50 ${
        field.invalid
          ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/40"
          : "border-border focus-visible:border-ring focus-visible:ring-ring/50"
      }`}
    />
  );
}

const MODEL_REF = /^[^/\s]+\/[^\s]+$/;

export function ModelRefInput(props: TextInputProps & { allowEmpty: boolean }) {
  return <TextInput {...props} pattern={MODEL_REF} />;
}
