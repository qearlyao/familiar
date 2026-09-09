import { useState, type FormEvent } from "react";
import { IconX } from "../organicIcons";
import { byGateway, modelLeaf, modelRoute } from "@/lib/modelRoutes";

export function ModelRows({
  models,
  current,
  disabled,
  onChange,
  added = [],
  onRemove,
  idPrefix,
}: {
  models: string[];
  current: string | undefined;
  disabled: boolean;
  onChange: (model: string) => void;
  added?: string[];
  onRemove?: (model: string) => void;
  idPrefix: string;
}) {
  const addedSet = new Set(added);
  const groups = byGateway(models);

  const row = (model: string) => {
    const route = modelRoute(model, groups.length > 0);
    return (
          <label key={model} className="model-row">
            <input type="radio" name={idPrefix} value={model} checked={model === current} disabled={disabled} onChange={() => onChange(model)} />
            <span className="model-radio" />
            <span className="model-name">
              {route && `${route}/`}
              <b>{modelLeaf(model)}</b>
            </span>
            {addedSet.has(model) && <span className="model-added">added</span>}
            {addedSet.has(model) && onRemove && (
              <button
                type="button"
                className="model-remove"
                aria-label={`remove ${model}`}
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(model);
                }}
              >
                <IconX />
              </button>
            )}
          </label>
    );
  };

  return (
    <div className="model-rows" role="radiogroup" aria-label={idPrefix}>
      {groups.length > 0
        ? groups.map(({ gateway, models: list }) => (
            <div key={gateway} className="model-group">
              <span className="model-route-head">{gateway}</span>
              {list.map(row)}
            </div>
          ))
        : models.map(row)}
    </div>
  );
}

export function ModelSection({
  models,
  added,
  current,
  disabled,
  onChange,
  onAdd,
  onRemove,
}: {
  models: string[];
  added: string[];
  current: string | undefined;
  disabled: boolean;
  onChange: (model: string) => void;
  onAdd: (model: string) => Promise<void>;
  onRemove: (model: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | undefined>();

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
    <>
      <ModelRows models={models} current={current} disabled={disabled || busy} onChange={onChange} added={added} onRemove={(model) => void onRemove(model).catch(() => undefined)} idPrefix="model" />
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
          add
        </button>
      </form>
      {addError && (
        <p role="alert" className="settings-error">
          {addError}
        </p>
      )}
    </>
  );
}
