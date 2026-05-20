import { useState, type FormEvent, type MouseEvent } from "react";
import { X } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import type { SettingSource } from "@/lib/api";

interface ModelSectionProps {
  models: string[];
  added: string[];
  current: string | undefined;
  source: SettingSource | undefined;
  disabled: boolean;
  onChange: (model: string) => void;
  onAdd: (model: string) => Promise<void>;
  onRemove: (model: string) => Promise<void>;
}

export function ModelSection({
  models,
  added,
  current,
  source,
  disabled,
  onChange,
  onAdd,
  onRemove,
}: ModelSectionProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | undefined>();
  const addedSet = new Set(added);

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

  const handleRemove = async (event: MouseEvent, model: string) => {
    event.preventDefault();
    event.stopPropagation();
    setBusy(true);
    try {
      await onRemove(model);
    } catch {
      // surfaced via parent error
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3 className="font-serif text-lg leading-tight tracking-tight text-foreground">model</h3>
      <p className="mt-1 font-serif text-xs italic text-muted-foreground">
        which language model carries this conversation.
      </p>
      <RadioGroup
        value={current ?? ""}
        onValueChange={onChange}
        disabled={disabled}
        className="mt-4 grid gap-1"
      >
        {models.map((model) => {
          const id = `model-${model}`;
          const isActive = model === current;
          const isAdded = addedSet.has(model);
          const [provider, ...rest] = model.split("/");
          const name = rest.join("/");
          return (
            <Label
              key={model}
              htmlFor={id}
              className="group/row flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent has-data-[state=checked]:bg-primary has-data-[state=checked]:text-primary-foreground has-data-[state=checked]:hover:bg-primary"
            >
              <RadioGroupItem value={model} id={id} />
              <span className="min-w-0 flex-1 font-mono text-sm leading-tight">
                <span className={isActive ? "text-primary-foreground/70" : "text-muted-foreground group-hover/row:text-foreground"}>{provider}</span>
                <span className={isActive ? "text-primary-foreground/70" : "text-muted-foreground group-hover/row:text-foreground"}>/</span>
                <span className={isActive ? "text-primary-foreground" : "text-muted-foreground group-hover/row:text-foreground"}>{name}</span>
              </span>
              {isAdded ? (
                <button
                  type="button"
                  onClick={(event) => handleRemove(event, model)}
                  aria-label={`remove ${model}`}
                  disabled={busy || disabled}
                  className={
                    "flex size-6 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed " +
                    (isActive
                      ? "text-primary-foreground/70 hover:text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground")
                  }
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </Label>
          );
        })}
      </RadioGroup>
      {current && source ? (
        <p className="mt-2 font-serif text-xs italic text-muted-foreground/70">
          {source === "override" ? "set for this channel" : "inherited from default config"}
        </p>
      ) : null}
      <form onSubmit={handleSubmit} className="mt-4 flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (addError) setAddError(undefined);
          }}
          placeholder="provider/model-id"
          spellCheck={false}
          autoComplete="off"
          disabled={busy || disabled}
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
        />
        <Button
          type="submit"
          variant="outline"
          size="default"
          disabled={busy || disabled || !draft.trim()}
        >
          add
        </Button>
      </form>
      {addError ? (
        <p className="mt-2 font-serif text-xs italic text-destructive">{addError}</p>
      ) : null}
    </section>
  );
}
