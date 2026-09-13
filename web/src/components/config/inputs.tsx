import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useCommittedInput } from "./useCommittedInput";

export function EnumToggle<T extends string>({
  value,
  options,
  ariaPrefix,
  disabled,
  onChange,
}: {
  value: T | undefined;
  options: readonly { value: T; label: string }[];
  ariaPrefix: string;
  disabled: boolean;
  onChange: (next: T) => void;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaPrefix}>
      {options.map((option) => (
        <button key={option.value} type="button" className="seg-pill" aria-pressed={option.value === value} disabled={disabled} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

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
  return (
    <button type="button" role="switch" className="switch" aria-checked={enabled === true} aria-label={ariaPrefix} disabled={disabled || enabled === undefined} onClick={() => onChange(!enabled)}>
      <i />
    </button>
  );
}

const MS_PER_MIN = 60_000;

export function MinuteInput({ valueMs, disabled, onCommit }: { valueMs: number | undefined; disabled: boolean; onCommit: (ms: number) => Promise<void> }) {
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
  return <input {...field.inputProps} type="number" inputMode="numeric" disabled={disabled || field.busy} min={1} className="pill-input is-inline" />;
}

export function NumberInput({
  value,
  step = 1,
  min,
  max,
  scale = 1,
  inline = false,
  disabled,
  onCommit,
}: {
  value: number | undefined;
  step?: number;
  min?: number;
  max?: number;
  /** display = stored × scale (e.g. 100 to show a fraction as a percent) */
  scale?: number;
  inline?: boolean;
  disabled: boolean;
  onCommit: (v: number) => Promise<void>;
}) {
  const shown = value === undefined ? "" : String(Math.round(value * scale * 1e6) / 1e6);
  const field = useCommittedInput(
    shown,
    (draft) => {
      const parsed = Number(draft);
      if (!Number.isFinite(parsed)) return "reset";
      if (min !== undefined && parsed < min) return "reset";
      if (max !== undefined && parsed > max) return "reset";
      const stored = parsed / scale;
      return stored === value ? "reset" : { value: stored };
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
      className={cn("pill-input", inline && "is-inline")}
    />
  );
}

/** A prose line with inline controls: "wakes after [45] min of quiet". */
export function Sentence({ children }: { children: ReactNode }) {
  return <p className="settings-sentence">{children}</p>;
}

/** An inline box and its unit, kept on one line so "[75]%" never wraps apart. */
export function Unit({ children }: { children: ReactNode }) {
  return <span className="settings-unit">{children}</span>;
}

/** One small card on a settings page: a Caprasimo title, whatever sits at the right of it, then the controls. */
export function Card({ title, hint, action, off, bare, children }: { title: string; hint?: string; action?: ReactNode; off?: boolean; bare?: boolean; children?: ReactNode }) {
  return (
    <section className={cn("settings-card", off && "is-off", bare && "is-bare")}>
      <div className="settings-card-head">
        <div>
          <h4>{title}</h4>
          {hint && <p>{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A label over its control. A div, not a label: a label around a pill group would press its first pill. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="settings-field">
      <span>{label}</span>
      {children}
    </div>
  );
}

/** A tuning number under an "advanced" fold: a label pill on desktop (hint in the tooltip), a labelled row on phones. */
export function Fine({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <label className="settings-fine" title={hint}>
      <span>
        {label}
        <small>{hint}</small>
      </span>
      {children}
    </label>
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

export function TextInput({ value, placeholder, allowEmpty = false, pattern, disabled, onCommit }: TextInputProps) {
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
      className="pill-input"
    />
  );
}

const MODEL_REF = /^[^/\s]+\/[^\s]+$/;

export function ModelRefInput(props: TextInputProps & { allowEmpty: boolean }) {
  return <TextInput {...props} pattern={MODEL_REF} />;
}
