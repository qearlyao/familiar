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

/** The knob. `labelled` also says the word, for the switch that sits at the head of a panel. */
export function OnOffToggle({
  enabled,
  disabled,
  labelled,
  ariaPrefix,
  onChange,
}: {
  enabled: boolean | undefined;
  disabled: boolean;
  labelled?: boolean;
  ariaPrefix: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className={labelled ? "switch-word" : "switch"}
      aria-checked={enabled === true}
      aria-label={ariaPrefix}
      disabled={disabled || enabled === undefined}
      onClick={() => onChange(!enabled)}
    >
      {labelled && <span>{enabled ? "on" : "off"}</span>}
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
  return <input {...field.inputProps} type="number" inputMode="numeric" disabled={disabled || field.busy} min={1} className="pill-input is-number" />;
}

export function NumberInput({
  value,
  step = 1,
  min,
  max,
  scale = 1,
  disabled,
  onCommit,
}: {
  value: number | undefined;
  step?: number;
  min?: number;
  max?: number;
  /** display = stored × scale (e.g. 100 to show a fraction as a percent) */
  scale?: number;
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
      className="pill-input is-number"
    />
  );
}

/** One small card on a settings page: a Caprasimo title, whatever sits at the right of it, then the controls. */
export function Card({ title, hint, action, off, wide, children }: { title: string; hint?: string; action?: ReactNode; off?: boolean; wide?: boolean; children?: ReactNode }) {
  return (
    <section className={cn("settings-card", off && "is-off", wide && "is-wide")}>
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

/** One setting on its own line under a rule: what it is on the left, its one value hard right. */
export function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <span>{label}</span>
        {help && <small>{help}</small>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/** The rows of a panel, ruled apart. */
export function Rows({ children }: { children: ReactNode }) {
  return <div className="settings-rows">{children}</div>;
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

/** provider/model, the shape every model reference takes */
export const MODEL_REF = /^[^/\s]+\/[^\s]+$/;
