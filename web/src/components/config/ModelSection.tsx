import { useState, type FormEvent } from "react";
import type { ThinkingLevel } from "@/lib/api";
import { THINKING_ORDER } from "@/lib/thinkingLevels";
import { IconX } from "../organicIcons";
import { byGateway, modelLeaf, modelRoute } from "@/lib/modelRoutes";
import { Card, EnumToggle, Row, Rows } from "./inputs";

/** The model the conversation runs on, the shelf of models to pick from, and how long it deliberates. */
export function ModelSection({
  models,
  added,
  current,
  thinking,
  supportedThinking,
  disabled,
  onChange,
  onThinking,
  onAdd,
  onRemove,
}: {
  models: string[];
  added: string[];
  current: string | undefined;
  thinking: ThinkingLevel | undefined;
  supportedThinking: ThinkingLevel[];
  disabled: boolean;
  onChange: (model: string) => void;
  onThinking: (level: ThinkingLevel) => void;
  onAdd: (model: string) => Promise<void>;
  onRemove: (model: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | undefined>();
  const [gateway, setGateway] = useState<string | undefined>();
  const groups = byGateway(models);
  const shown = groups.find((g) => g.gateway === gateway)?.models ?? models;
  const addedSet = new Set(added);
  const visibleThinking = THINKING_ORDER.filter((level) => supportedThinking.includes(level));
  const thinkingOptions = (visibleThinking.length > 0 ? visibleThinking : THINKING_ORDER).map((level) => ({ value: level, label: level }));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    if (!value.includes("/") || value.startsWith("/") || value.endsWith("/")) {
      setAddError("format must be provider/model-id");
      return;
    }
    setAddError(undefined);
    setBusy(true);
    try {
      await onAdd(value);
      setDraft("");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="model" wide action={<span className="settings-count">{shown.length} of {models.length} shown</span>}>
      {current && (
        <p className="model-current">
          <em>in use</em>
          <span>
            {modelRoute(current, false)}/<b>{modelLeaf(current)}</b>
          </span>
        </p>
      )}
      {groups.length > 0 && (
        <div className="model-filters" role="group" aria-label="filter by provider">
          {[{ gateway: undefined, models }, ...groups].map((g) => (
            <button key={g.gateway ?? "all"} type="button" className="model-filter" aria-pressed={g.gateway === gateway} onClick={() => setGateway(g.gateway)}>
              {g.gateway ?? "all"}
              <span>{g.models.length}</span>
            </button>
          ))}
        </div>
      )}
      <div className="model-bench" role="radiogroup" aria-label="model">
        {shown.map((model) => (
          <label key={model} className="model-row">
            <input type="radio" name="model" value={model} checked={model === current} disabled={disabled || busy} onChange={() => onChange(model)} />
            <span className="model-radio" />
            <span className="model-name">
              {modelRoute(model, false)}/<b>{modelLeaf(model)}</b>
            </span>
            {addedSet.has(model) && (
              <button
                type="button"
                className="model-remove"
                aria-label={`remove ${model}`}
                title="you added this one — remove it"
                disabled={disabled || busy}
                onClick={(event) => {
                  event.preventDefault();
                  void onRemove(model).catch(() => undefined);
                }}
              >
                <IconX />
              </button>
            )}
          </label>
        ))}
      </div>
      <form onSubmit={handleSubmit} className="model-add">
        <input
          type="text"
          className="pill-input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (addError) setAddError(undefined);
          }}
          placeholder="provider/model-id"
          spellCheck={false}
          autoComplete="off"
          disabled={busy || disabled}
          aria-invalid={addError ? true : undefined}
          aria-label="add a model"
        />
        <button type="submit" className="pill-button" disabled={busy || disabled || !draft.trim()}>
          add model
        </button>
      </form>
      {addError && (
        <p role="alert" className="settings-error">
          {addError}
        </p>
      )}
      <Rows>
        <Row label="thinking effort" help="how long they deliberate before answering.">
          <EnumToggle value={thinking} options={thinkingOptions} ariaPrefix="thinking" disabled={disabled} onChange={onThinking} />
        </Row>
      </Rows>
    </Card>
  );
}
