import { useEffect, useState, type ReactNode } from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ConfigKey, SettingSource } from "@/lib/api";

interface MemorySectionProps {
  enabled: boolean | undefined;
  model: string | undefined;
  modelSource: SettingSource | undefined;
  models: string[];
  contextThreshold: number | undefined;
  freshTailCount: number | undefined;
  leafChunkTokens: number | undefined;
  leafTargetTokens: number | undefined;
  condenseGroupSize: number | undefined;
  maxSummaryDepth: number | undefined;
  newSessionRetainDepth: number | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
  onClear: (key: ConfigKey) => Promise<void>;
}

const toggleClass =
  "h-9 rounded-md px-3.5 text-sm lowercase text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary";

function NumberInput({
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
  const [draft, setDraft] = useState<string>(live);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(live);
  }, [live]);

  const commit = async () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(live);
      return;
    }
    if (min !== undefined && parsed < min) {
      setDraft(live);
      return;
    }
    if (max !== undefined && parsed > max) {
      setDraft(live);
      return;
    }
    if (parsed === value) return;
    setBusy(true);
    try {
      await onCommit(parsed);
    } catch {
      setDraft(live);
    } finally {
      setBusy(false);
    }
  };

  return (
    <input
      type="number"
      inputMode={step < 1 ? "decimal" : "numeric"}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      disabled={disabled || busy}
      step={step}
      min={min}
      max={max}
      className="h-8 w-20 rounded-md border border-border bg-background px-2 font-mono text-sm text-right text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
    />
  );
}

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <span className="flex-1 font-serif text-sm text-foreground">{label}</span>
        {children}
      </div>
      {description ? (
        <p className="font-serif text-xs italic text-muted-foreground/70">{description}</p>
      ) : null}
    </div>
  );
}

function SubLabel({ children }: { children: ReactNode }) {
  return (
    <h4 className="mb-3 font-serif text-xs italic tracking-wide text-muted-foreground">
      {children}
    </h4>
  );
}

export function MemorySection({
  enabled,
  model,
  modelSource,
  models,
  contextThreshold,
  freshTailCount,
  leafChunkTokens,
  leafTargetTokens,
  condenseGroupSize,
  maxSummaryDepth,
  newSessionRetainDepth,
  disabled,
  onChange,
  onClear,
}: MemorySectionProps) {
  const isOn = enabled === true;
  const sectionDisabled = disabled || !isOn;
  return (
    <>
      <ToggleGroup
        type="single"
        value={enabled === undefined ? "" : isOn ? "on" : "off"}
        onValueChange={(value) => {
          if (value) void onChange("memory.lcm.enabled", value === "on");
        }}
        disabled={disabled}
        spacing={1}
        className="rounded-lg bg-muted/40 p-1"
      >
        <ToggleGroupItem value="on" aria-label="compaction on" className={toggleClass}>
          on
        </ToggleGroupItem>
        <ToggleGroupItem value="off" aria-label="compaction off" className={toggleClass}>
          off
        </ToggleGroupItem>
      </ToggleGroup>

      <div className="mt-6">
        <SubLabel>compaction model</SubLabel>
        <RadioGroup
          value={model ?? ""}
          onValueChange={(value) => void onChange("memory.lcm.model", value)}
          disabled={sectionDisabled}
          className="grid gap-1"
        >
          {models.map((entry) => {
            const id = `memory-model-${entry}`;
            const isActive = entry === model;
            const [provider, ...rest] = entry.split("/");
            const name = rest.join("/");
            return (
              <Label
                key={entry}
                htmlFor={id}
                className="group/row flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent has-data-[state=checked]:bg-primary has-data-[state=checked]:text-primary-foreground has-data-[state=checked]:hover:bg-primary"
              >
                <RadioGroupItem value={entry} id={id} />
                <span className="min-w-0 flex-1 font-mono text-sm leading-tight">
                  <span className={isActive ? "text-primary-foreground/70" : "text-muted-foreground group-hover/row:text-foreground"}>{provider}</span>
                  <span className={isActive ? "text-primary-foreground/70" : "text-muted-foreground group-hover/row:text-foreground"}>/</span>
                  <span className={isActive ? "text-primary-foreground" : "text-muted-foreground group-hover/row:text-foreground"}>{name}</span>
                </span>
              </Label>
            );
          })}
        </RadioGroup>
        {modelSource === "override" ? (
          <button
            type="button"
            onClick={() => void onClear("memory.lcm.model")}
            disabled={sectionDisabled}
            className="mt-2 font-serif text-xs italic text-muted-foreground/70 transition-colors hover:text-foreground disabled:opacity-50"
          >
            set just for compaction · use default instead
          </button>
        ) : model ? (
          <p className="mt-2 font-serif text-xs italic text-muted-foreground/70">
            following your conversation model
          </p>
        ) : null}
      </div>

      <div className="mt-6">
        <SubLabel>tuning</SubLabel>
        <div className="grid gap-4">
          <Row
            label="context threshold"
            description="fraction of context that triggers compaction"
          >
            <NumberInput
              value={contextThreshold}
              step={0.05}
              min={0}
              max={1}
              disabled={sectionDisabled}
              onCommit={(v) => onChange("memory.lcm.contextThreshold", v)}
            />
          </Row>
          <Row label="fresh tail count" description="most recent messages kept raw, never compacted">
            <NumberInput
              value={freshTailCount}
              min={1}
              disabled={sectionDisabled}
              onCommit={(v) => onChange("memory.lcm.freshTailCount", v)}
            />
          </Row>
          <Row label="leaf chunk tokens" description="max tokens of input per leaf summary">
            <NumberInput
              value={leafChunkTokens}
              min={1}
              disabled={sectionDisabled}
              onCommit={(v) => onChange("memory.lcm.leafChunkTokens", v)}
            />
          </Row>
          <Row label="leaf target tokens" description="target tokens per leaf summary output">
            <NumberInput
              value={leafTargetTokens}
              min={1}
              disabled={sectionDisabled}
              onCommit={(v) => onChange("memory.lcm.leafTargetTokens", v)}
            />
          </Row>
          <Row label="condense group size" description="how many summaries combine into one at the next level">
            <NumberInput
              value={condenseGroupSize}
              min={1}
              disabled={sectionDisabled}
              onCommit={(v) => onChange("memory.lcm.condenseGroupSize", v)}
            />
          </Row>
          <Row label="max summary depth" description="deepest level of recursive summary-of-summaries">
            <NumberInput
              value={maxSummaryDepth}
              min={1}
              disabled={sectionDisabled}
              onCommit={(v) => onChange("memory.lcm.maxSummaryDepth", v)}
            />
          </Row>
          <Row
            label="kept after /new"
            description="lowest summary depth kept after /new. -1 keeps full context, 0 keeps every summary."
          >
            <NumberInput
              value={newSessionRetainDepth}
              min={-1}
              disabled={sectionDisabled}
              onCommit={(v) => onChange("memory.lcm.newSessionRetainDepth", v)}
            />
          </Row>
        </div>
      </div>

      <p className="mt-6 font-serif text-xs italic text-muted-foreground/60">
        embedding model lives in config.toml. swapping it invalidates existing memory.
      </p>
    </>
  );
}
