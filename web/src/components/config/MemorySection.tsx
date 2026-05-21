import { useState, type ReactNode } from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ConfigKey, SettingSource } from "@/lib/api";

interface MemorySectionProps {
  compactionEnabled: boolean | undefined;
  compactionModel: string | undefined;
  compactionModelSource: SettingSource | undefined;
  models: string[];
  contextThreshold: number | undefined;
  freshTailCount: number | undefined;
  leafChunkTokens: number | undefined;
  leafTargetTokens: number | undefined;
  condenseGroupSize: number | undefined;
  maxSummaryDepth: number | undefined;
  newSessionRetainDepth: number | undefined;
  ambientEnabled: boolean | undefined;
  topK: number | undefined;
  minQueryLength: number | undefined;
  throttleSeconds: number | undefined;
  weightSimilarity: number | undefined;
  weightValence: number | undefined;
  weightRecency: number | undefined;
  weightIntensity: number | undefined;
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

function SubBlockLabel({ children }: { children: ReactNode }) {
  return (
    <h4 className="mb-4 font-serif text-base lowercase tracking-tight text-foreground">
      {children}
    </h4>
  );
}

function OnOffToggle({
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

export function MemorySection({
  compactionEnabled,
  compactionModel,
  compactionModelSource,
  models,
  contextThreshold,
  freshTailCount,
  leafChunkTokens,
  leafTargetTokens,
  condenseGroupSize,
  maxSummaryDepth,
  newSessionRetainDepth,
  ambientEnabled,
  topK,
  minQueryLength,
  throttleSeconds,
  weightSimilarity,
  weightValence,
  weightRecency,
  weightIntensity,
  disabled,
  onChange,
  onClear,
}: MemorySectionProps) {
  const compactionOff = disabled || compactionEnabled !== true;
  const ambientOff = disabled || ambientEnabled !== true;

  return (
    <>
      <section>
        <SubBlockLabel>compaction</SubBlockLabel>
        <OnOffToggle
          enabled={compactionEnabled}
          disabled={disabled}
          ariaPrefix="compaction"
          onChange={(next) => void onChange("memory.lcm.enabled", next)}
        />
        <div className="mt-4">
          <RadioGroup
            value={compactionModel ?? ""}
            onValueChange={(value) => void onChange("memory.lcm.model", value)}
            disabled={compactionOff}
            className="grid gap-1"
          >
            {models.map((entry) => {
              const id = `memory-model-${entry}`;
              const isActive = entry === compactionModel;
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
          {compactionModelSource === "override" ? (
            <button
              type="button"
              onClick={() => void onClear("memory.lcm.model")}
              disabled={compactionOff}
              className="mt-2 font-serif text-xs italic text-muted-foreground/70 transition-colors hover:text-foreground disabled:opacity-50"
            >
              set just for compaction · use default instead
            </button>
          ) : compactionModel ? (
            <p className="mt-2 font-serif text-xs italic text-muted-foreground/70">
              following your conversation model
            </p>
          ) : null}
        </div>
        <div className="mt-4 grid gap-4">
          <Row label="context threshold" description="fraction of context that triggers compaction">
            <NumberInput
              key={`context-${contextThreshold ?? "default"}`}
              value={contextThreshold}
              step={0.05}
              min={0}
              max={1}
              disabled={compactionOff}
              onCommit={(v) => onChange("memory.lcm.contextThreshold", v)}
            />
          </Row>
          <Row label="fresh tail count" description="most recent messages kept raw, never compacted">
            <NumberInput
              key={`fresh-${freshTailCount ?? "default"}`}
              value={freshTailCount}
              min={1}
              disabled={compactionOff}
              onCommit={(v) => onChange("memory.lcm.freshTailCount", v)}
            />
          </Row>
          <Row label="leaf chunk tokens" description="max tokens of input per leaf summary">
            <NumberInput
              key={`leaf-chunk-${leafChunkTokens ?? "default"}`}
              value={leafChunkTokens}
              min={1}
              disabled={compactionOff}
              onCommit={(v) => onChange("memory.lcm.leafChunkTokens", v)}
            />
          </Row>
          <Row label="leaf target tokens" description="target tokens per leaf summary output">
            <NumberInput
              key={`leaf-target-${leafTargetTokens ?? "default"}`}
              value={leafTargetTokens}
              min={1}
              disabled={compactionOff}
              onCommit={(v) => onChange("memory.lcm.leafTargetTokens", v)}
            />
          </Row>
          <Row label="condense group size" description="how many summaries combine into one at the next level">
            <NumberInput
              key={`condense-${condenseGroupSize ?? "default"}`}
              value={condenseGroupSize}
              min={1}
              disabled={compactionOff}
              onCommit={(v) => onChange("memory.lcm.condenseGroupSize", v)}
            />
          </Row>
          <Row label="max summary depth" description="deepest level of recursive summary-of-summaries">
            <NumberInput
              key={`max-depth-${maxSummaryDepth ?? "default"}`}
              value={maxSummaryDepth}
              min={1}
              disabled={compactionOff}
              onCommit={(v) => onChange("memory.lcm.maxSummaryDepth", v)}
            />
          </Row>
          <Row
            label="kept after /new"
            description="lowest summary depth kept after /new. -1 keeps full context, 0 keeps every summary."
          >
            <NumberInput
              key={`retain-${newSessionRetainDepth ?? "default"}`}
              value={newSessionRetainDepth}
              min={-1}
              disabled={compactionOff}
              onCommit={(v) => onChange("memory.lcm.newSessionRetainDepth", v)}
            />
          </Row>
        </div>
      </section>

      <section className="mt-8">
        <SubBlockLabel>ambient</SubBlockLabel>
        <OnOffToggle
          enabled={ambientEnabled}
          disabled={disabled}
          ariaPrefix="ambient"
          onChange={(next) => void onChange("memory.ambient.enabled", next)}
        />
        <div className="mt-4 grid gap-4">
          <Row label="top k" description="how many memories to surface per query">
            <NumberInput
              key={`top-k-${topK ?? "default"}`}
              value={topK}
              min={1}
              disabled={ambientOff}
              onCommit={(v) => onChange("memory.ambient.topK", v)}
            />
          </Row>
          <Row label="min query length" description="minimum query chars before recall fires">
            <NumberInput
              key={`min-query-${minQueryLength ?? "default"}`}
              value={minQueryLength}
              min={0}
              disabled={ambientOff}
              onCommit={(v) => onChange("memory.ambient.minQueryLength", v)}
            />
          </Row>
          <Row label="throttle seconds" description="cooldown between recalls">
            <NumberInput
              key={`throttle-${throttleSeconds ?? "default"}`}
              value={throttleSeconds}
              min={0}
              disabled={ambientOff}
              onCommit={(v) => onChange("memory.ambient.throttleSeconds", v)}
            />
          </Row>
          <Row label="similarity weight" description="semantic match to your query">
            <NumberInput
              key={`weight-similarity-${weightSimilarity ?? "default"}`}
              value={weightSimilarity}
              step={0.05}
              min={0}
              disabled={ambientOff}
              onCommit={(v) => onChange("memory.ambient.weightSimilarity", v)}
            />
          </Row>
          <Row label="valence weight" description="emotional charge of the memory">
            <NumberInput
              key={`weight-valence-${weightValence ?? "default"}`}
              value={weightValence}
              step={0.05}
              min={0}
              disabled={ambientOff}
              onCommit={(v) => onChange("memory.ambient.weightValence", v)}
            />
          </Row>
          <Row label="recency weight" description="favors recent memories">
            <NumberInput
              key={`weight-recency-${weightRecency ?? "default"}`}
              value={weightRecency}
              step={0.05}
              min={0}
              disabled={ambientOff}
              onCommit={(v) => onChange("memory.ambient.weightRecency", v)}
            />
          </Row>
          <Row label="intensity weight" description="favors strongly-felt memories">
            <NumberInput
              key={`weight-intensity-${weightIntensity ?? "default"}`}
              value={weightIntensity}
              step={0.05}
              min={0}
              disabled={ambientOff}
              onCommit={(v) => onChange("memory.ambient.weightIntensity", v)}
            />
          </Row>
        </div>
      </section>

      <p className="mt-8 font-serif text-xs italic text-muted-foreground/60">
        embedding model lives in config.toml. swapping it invalidates existing memory.
      </p>
    </>
  );
}
