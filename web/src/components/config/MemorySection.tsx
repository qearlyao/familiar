import type { ConfigKey, ConfigValues } from "@/lib/api";
import { IconChevronDown } from "../organicIcons";
import { ModelRows } from "./ModelSection";
import { Field, NumberInput, OnOffToggle, Sentence } from "./inputs";

export function MemorySection({
  values,
  models,
  disabled,
  onChange,
  onClear,
}: {
  values: ConfigValues | undefined;
  models: string[];
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
  onClear: (key: ConfigKey) => Promise<void>;
}) {
  const compactionEnabled = values?.["memory.lcm.enabled"].value;
  const ambientEnabled = values?.["memory.ambient.enabled"].value;
  const compactionModel = values?.["memory.lcm.model"].value;
  const compactionModelSource = values?.["memory.lcm.model"].source;
  const compactionOff = disabled || compactionEnabled !== true;
  const ambientOff = disabled || ambientEnabled !== true;
  const num = (key: ConfigKey, opts: { step?: number; min?: number; max?: number; scale?: number; inline?: boolean }, off: boolean) => (
    <NumberInput value={values?.[key].value as number | undefined} {...opts} disabled={off} onCommit={(v) => onChange(key, v)} />
  );

  return (
    <>
      <div className={compactionEnabled === true ? "settings-card" : "settings-card is-off"}>
        <div className="settings-card-head">
          <div className="settings-block-title">
            <span>compaction</span>
            <span>how older conversation is condensed into summaries.</span>
          </div>
          <OnOffToggle enabled={compactionEnabled} disabled={disabled} ariaPrefix="compaction" onChange={(next) => void onChange("memory.lcm.enabled", next)} />
        </div>
        <Sentence>
          keeps the last {num("memory.lcm.freshTailCount", { min: 1, inline: true }, compactionOff)} messages whole, and compacts once the context passes{" "}
          {num("memory.lcm.contextThreshold", { step: 5, min: 0, max: 100, scale: 100, inline: true }, compactionOff)} %.
        </Sentence>
        <p className="settings-subtitle">summaries written by</p>
        <ModelRows models={models} current={compactionModel} disabled={compactionOff} onChange={(model) => void onChange("memory.lcm.model", model)} idPrefix="compaction model" />
        {compactionModelSource === "override" ? (
          <button type="button" className="pill-button is-quiet" style={{ alignSelf: "flex-start" }} disabled={compactionOff} onClick={() => void onClear("memory.lcm.model")}>
            use the conversation model instead
          </button>
        ) : compactionModel ? (
          <p className="settings-note">following your conversation model</p>
        ) : null}
        {/* Tuning constants: open by default on desktop, folded on phones. */}
        <details className="settings-fold" open={!window.matchMedia("(max-width: 700px)").matches}>
          <summary>
            the fine numbers
            <IconChevronDown />
          </summary>
          <div className="settings-grid">
            <Field label="leaf chunk" hint="max tokens read per leaf summary">
              {num("memory.lcm.leafChunkTokens", { min: 1 }, compactionOff)}
            </Field>
            <Field label="leaf target" hint="tokens each leaf summary aims for">
              {num("memory.lcm.leafTargetTokens", { min: 1 }, compactionOff)}
            </Field>
            <Field label="condense group" hint="summaries folded into one at the next level">
              {num("memory.lcm.condenseGroupSize", { min: 1 }, compactionOff)}
            </Field>
            <Field label="max depth" hint="deepest summary-of-summaries">
              {num("memory.lcm.maxSummaryDepth", { min: 1 }, compactionOff)}
            </Field>
            <Field label="kept after /new" hint="-1 keeps everything, 0 keeps every summary">
              {num("memory.lcm.newSessionRetainDepth", { min: -1 }, compactionOff)}
            </Field>
          </div>
        </details>
      </div>

      <div className={ambientEnabled === true ? "settings-card" : "settings-card is-off"}>
        <div className="settings-card-head">
          <div className="settings-block-title">
            <span>ambient</span>
            <span>how earlier memories return on their own.</span>
          </div>
          <OnOffToggle enabled={ambientEnabled} disabled={disabled} ariaPrefix="ambient" onChange={(next) => void onChange("memory.ambient.enabled", next)} />
        </div>
        <Sentence>
          brings back up to {num("memory.ambient.topK", { min: 1, inline: true }, ambientOff)} memories, once a message runs at least{" "}
          {num("memory.ambient.minQueryLength", { min: 0, inline: true }, ambientOff)} characters, and no more than every{" "}
          {num("memory.ambient.throttleSeconds", { min: 0, inline: true }, ambientOff)} seconds.
        </Sentence>
        <p className="settings-subtitle">what pulls a memory back</p>
        <div className="settings-grid">
          <Field label="similarity" hint="how close it is to what you said">
            {num("memory.ambient.weightSimilarity", { step: 0.05, min: 0 }, ambientOff)}
          </Field>
          <Field label="valence" hint="its emotional charge">
            {num("memory.ambient.weightValence", { step: 0.05, min: 0 }, ambientOff)}
          </Field>
          <Field label="recency" hint="how recently it happened">
            {num("memory.ambient.weightRecency", { step: 0.05, min: 0 }, ambientOff)}
          </Field>
          <Field label="intensity" hint="how strongly it was felt">
            {num("memory.ambient.weightIntensity", { step: 0.05, min: 0 }, ambientOff)}
          </Field>
        </div>
        <p className="settings-note">weights are relative to each other, so only their balance matters.</p>
      </div>

      <p className="settings-note">the embedding model lives in config.toml. swapping it invalidates existing memory.</p>
    </>
  );
}
