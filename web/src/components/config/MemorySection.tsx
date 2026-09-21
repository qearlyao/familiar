import type { ReactNode } from "react";
import type { ConfigKey, ConfigValues } from "@/lib/api";
import { byGateway } from "@/lib/modelRoutes";
import { IconChevronDown } from "../organicIcons";
import { Card, NumberInput, OnOffToggle, Row, Rows } from "./inputs";

/** Bring an opened fold into view; when only a note or two sits below it, run on to the end of the page. */
function revealFold(fold: HTMLElement, body: HTMLElement) {
  const style = getComputedStyle(body);
  const f = fold.getBoundingClientRect();
  const b = body.getBoundingClientRect();
  const foldTop = body.scrollTop + f.top - b.top - parseFloat(style.paddingTop);
  const foldBottom = body.scrollTop + f.bottom - b.top;
  const contentEnd = body.scrollHeight - parseFloat(style.paddingBottom);
  const view = body.clientHeight - (parseFloat(style.scrollPaddingBottom) || 0);
  const end = contentEnd - foldBottom < 96 ? body.scrollHeight : foldBottom - view;
  const top = Math.min(end, foldTop); // never push the fold's own head out of sight
  if (top > body.scrollTop) body.scrollTo({ top, behavior: "smooth" });
}

function Advanced({ count, children }: { count: number; children: ReactNode }) {
  return (
    <details
      className="settings-fold"
      onToggle={(event) => {
        const fold = event.currentTarget;
        const body = fold.closest<HTMLElement>(".settings-body");
        if (fold.open && body) revealFold(fold, body);
      }}
    >
      <summary>
        advanced · {count} values
        <IconChevronDown />
      </summary>
      {children}
    </details>
  );
}

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
  const summaryModel = values?.["memory.lcm.model"];
  // not overridden means the summaries follow the conversation model
  const summaryPick = summaryModel?.source === "override" ? summaryModel.value : "";
  const summaryGroups = byGateway(models);
  const compactionOff = disabled || compactionEnabled !== true;
  const ambientOff = disabled || ambientEnabled !== true;
  const num = (key: ConfigKey, opts: { step?: number; min?: number; max?: number; scale?: number }, off: boolean) => (
    <NumberInput value={values?.[key].value as number | undefined} {...opts} disabled={off} onCommit={(v) => onChange(key, v)} />
  );
  const option = (model: string) => (
    <option key={model} value={model}>
      {model}
    </option>
  );

  return (
    <>
      <Card
        title="compaction"
        hint="how older conversation is condensed into summaries."
        off={compactionEnabled !== true}
        action={<OnOffToggle enabled={compactionEnabled} disabled={disabled} labelled ariaPrefix="compaction" onChange={(next) => void onChange("memory.lcm.enabled", next)} />}
      >
        <Rows>
          <Row label="messages kept whole" help="the freshest turns are never summarised.">
            {num("memory.lcm.freshTailCount", { min: 1 }, compactionOff)}
          </Row>
          <Row label="context percent" help="compacts once the window is this full.">
            {num("memory.lcm.contextThreshold", { step: 5, min: 0, max: 100, scale: 100 }, compactionOff)}
          </Row>
          <Row label="summaries written by">
            <span className="settings-select">
              <select
                aria-label="summaries written by"
                value={summaryPick}
                disabled={compactionOff}
                onChange={(event) => void (event.target.value ? onChange("memory.lcm.model", event.target.value) : onClear("memory.lcm.model"))}
              >
                <option value="">follow the conversation model</option>
                {summaryPick && !models.includes(summaryPick) && option(summaryPick)}
                {summaryGroups.length > 0
                  ? summaryGroups.map((g) => (
                      <optgroup key={g.gateway} label={g.gateway}>
                        {g.models.map(option)}
                      </optgroup>
                    ))
                  : models.map(option)}
              </select>
              <IconChevronDown />
            </span>
          </Row>
        </Rows>
        <Advanced count={5}>
          <Rows>
            <Row label="leaf chunk" help="max tokens read per leaf summary.">{num("memory.lcm.leafChunkTokens", { min: 1 }, compactionOff)}</Row>
            <Row label="leaf target" help="tokens each leaf summary aims for.">{num("memory.lcm.leafTargetTokens", { min: 1 }, compactionOff)}</Row>
            <Row label="condense group" help="summaries folded into one at the next level.">{num("memory.lcm.condenseGroupSize", { min: 1 }, compactionOff)}</Row>
            <Row label="max depth" help="deepest summary-of-summaries.">{num("memory.lcm.maxSummaryDepth", { min: 1 }, compactionOff)}</Row>
            <Row label="kept after /new" help="−1 keeps everything, 0 keeps every summary.">{num("memory.lcm.newSessionRetainDepth", { min: -1 }, compactionOff)}</Row>
          </Rows>
        </Advanced>
      </Card>

      <Card
        title="ambient memory"
        hint="how earlier memories return on their own."
        off={ambientEnabled !== true}
        action={<OnOffToggle enabled={ambientEnabled} disabled={disabled} labelled ariaPrefix="ambient memory" onChange={(next) => void onChange("memory.ambient.enabled", next)} />}
      >
        <Rows>
          <Row label="memories recalled" help="at most, per message.">{num("memory.ambient.topK", { min: 1 }, ambientOff)}</Row>
          <Row label="minimum query characters">{num("memory.ambient.minQueryLength", { min: 0 }, ambientOff)}</Row>
          <Row label="throttle seconds" help="at least this long between recalls.">{num("memory.ambient.throttleSeconds", { min: 0 }, ambientOff)}</Row>
        </Rows>
        <Advanced count={4}>
          <p className="settings-subtitle">what pulls a memory back — only the balance between these matters.</p>
          <Rows>
            <Row label="similarity" help="how close it is to what you said.">{num("memory.ambient.weightSimilarity", { step: 0.05, min: 0 }, ambientOff)}</Row>
            <Row label="valence" help="its emotional charge.">{num("memory.ambient.weightValence", { step: 0.05, min: 0 }, ambientOff)}</Row>
            <Row label="recency" help="how recently it happened.">{num("memory.ambient.weightRecency", { step: 0.05, min: 0 }, ambientOff)}</Row>
            <Row label="intensity" help="how strongly it was felt.">{num("memory.ambient.weightIntensity", { step: 0.05, min: 0 }, ambientOff)}</Row>
          </Rows>
        </Advanced>
        <p className="settings-note">the embedding model lives in config.toml. swapping it invalidates existing memory.</p>
      </Card>
    </>
  );
}
