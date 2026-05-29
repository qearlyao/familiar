import { type ReactNode } from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import type { ConfigKey, ConfigValues } from "@/lib/api";
import { NumberInput, OnOffToggle } from "./inputs";

interface MemorySectionProps {
  values: ConfigValues | undefined;
  models: string[];
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
  onClear: (key: ConfigKey) => Promise<void>;
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

export function MemorySection({ values, models, disabled, onChange, onClear }: MemorySectionProps) {
  const compactionEnabled = values?.["memory.lcm.enabled"].value;
  const compactionModel = values?.["memory.lcm.model"].value;
  const compactionModelSource = values?.["memory.lcm.model"].source;
  const compactionOff = disabled || compactionEnabled !== true;
  const ambientOff = disabled || values?.["memory.ambient.enabled"].value !== true;

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
              value={values?.["memory.lcm.contextThreshold"].value}
              step={0.05}
              min={0}
              max={1}
              disabled={compactionOff}
              onCommit={(v) => onChange("memory.lcm.contextThreshold", v)}
            />
          </Row>
          <Row label="fresh tail count" description="most recent messages kept raw, never compacted">
            <NumberInput
              value={values?.["memory.lcm.freshTailCount"].value}
              min={1}
              disabled={compactionOff}
              onCommit={(v) => onChange("memory.lcm.freshTailCount", v)}
            />
          </Row>
          <Row label="leaf chunk tokens" description="max tokens of input per leaf summary">
            <NumberInput
              value={values?.["memory.lcm.leafChunkTokens"].value}
              min={1}
              disabled={compactionOff}
              onCommit={(v) => onChange("memory.lcm.leafChunkTokens", v)}
            />
          </Row>
          <Row label="leaf target tokens" description="target tokens per leaf summary output">
            <NumberInput
              value={values?.["memory.lcm.leafTargetTokens"].value}
              min={1}
              disabled={compactionOff}
              onCommit={(v) => onChange("memory.lcm.leafTargetTokens", v)}
            />
          </Row>
          <Row label="condense group size" description="how many summaries combine into one at the next level">
            <NumberInput
              value={values?.["memory.lcm.condenseGroupSize"].value}
              min={1}
              disabled={compactionOff}
              onCommit={(v) => onChange("memory.lcm.condenseGroupSize", v)}
            />
          </Row>
          <Row label="max summary depth" description="deepest level of recursive summary-of-summaries">
            <NumberInput
              value={values?.["memory.lcm.maxSummaryDepth"].value}
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
              value={values?.["memory.lcm.newSessionRetainDepth"].value}
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
          enabled={values?.["memory.ambient.enabled"].value}
          disabled={disabled}
          ariaPrefix="ambient"
          onChange={(next) => void onChange("memory.ambient.enabled", next)}
        />
        <div className="mt-4 grid gap-4">
          <Row label="top k" description="how many memories to surface per query">
            <NumberInput
              value={values?.["memory.ambient.topK"].value}
              min={1}
              disabled={ambientOff}
              onCommit={(v) => onChange("memory.ambient.topK", v)}
            />
          </Row>
          <Row label="min query length" description="minimum query chars before recall fires">
            <NumberInput
              value={values?.["memory.ambient.minQueryLength"].value}
              min={0}
              disabled={ambientOff}
              onCommit={(v) => onChange("memory.ambient.minQueryLength", v)}
            />
          </Row>
          <Row label="throttle seconds" description="cooldown between recalls">
            <NumberInput
              value={values?.["memory.ambient.throttleSeconds"].value}
              min={0}
              disabled={ambientOff}
              onCommit={(v) => onChange("memory.ambient.throttleSeconds", v)}
            />
          </Row>
          <Row label="similarity weight" description="semantic match to your query">
            <NumberInput
              value={values?.["memory.ambient.weightSimilarity"].value}
              step={0.05}
              min={0}
              disabled={ambientOff}
              onCommit={(v) => onChange("memory.ambient.weightSimilarity", v)}
            />
          </Row>
          <Row label="valence weight" description="emotional charge of the memory">
            <NumberInput
              value={values?.["memory.ambient.weightValence"].value}
              step={0.05}
              min={0}
              disabled={ambientOff}
              onCommit={(v) => onChange("memory.ambient.weightValence", v)}
            />
          </Row>
          <Row label="recency weight" description="favors recent memories">
            <NumberInput
              value={values?.["memory.ambient.weightRecency"].value}
              step={0.05}
              min={0}
              disabled={ambientOff}
              onCommit={(v) => onChange("memory.ambient.weightRecency", v)}
            />
          </Row>
          <Row label="intensity weight" description="favors strongly-felt memories">
            <NumberInput
              value={values?.["memory.ambient.weightIntensity"].value}
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
