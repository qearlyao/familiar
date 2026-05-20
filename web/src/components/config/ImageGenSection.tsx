import { useEffect, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ConfigKey } from "@/lib/api";

interface ImageGenSectionProps {
  enabled: boolean | undefined;
  model: string | undefined;
  fallbackModel: string | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}

const toggleClass =
  "h-9 rounded-md px-3.5 text-sm lowercase text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary";

function ModelRefInput({
  value,
  placeholder,
  allowEmpty,
  disabled,
  onCommit,
}: {
  value: string | undefined;
  placeholder?: string;
  allowEmpty: boolean;
  disabled: boolean;
  onCommit: (next: string) => Promise<void>;
}) {
  const live = value ?? "";
  const [draft, setDraft] = useState<string>(live);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(live);
    setInvalid(false);
  }, [live]);

  const commit = async () => {
    const trimmed = draft.trim();
    if (trimmed === live) {
      setDraft(trimmed);
      setInvalid(false);
      return;
    }
    if (!trimmed) {
      if (!allowEmpty) {
        setDraft(live);
        setInvalid(false);
        return;
      }
    } else if (!/^[^/\s]+\/[^\s]+$/.test(trimmed)) {
      setInvalid(true);
      return;
    }
    setBusy(true);
    setInvalid(false);
    try {
      await onCommit(trimmed);
    } catch {
      setDraft(live);
    } finally {
      setBusy(false);
    }
  };

  return (
    <input
      type="text"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => {
        setDraft(event.target.value);
        if (invalid) setInvalid(false);
      }}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      disabled={disabled || busy}
      className={`h-9 w-full rounded-md border bg-background px-3 font-mono text-sm text-foreground focus-visible:ring-3 focus-visible:outline-none disabled:opacity-50 ${
        invalid
          ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/40"
          : "border-border focus-visible:border-ring focus-visible:ring-ring/50"
      }`}
    />
  );
}

export function ImageGenSection({
  enabled,
  model,
  fallbackModel,
  disabled,
  onChange,
}: ImageGenSectionProps) {
  const isOn = enabled === true;
  const fieldsDisabled = disabled || !isOn;
  return (
    <>
      <ToggleGroup
        type="single"
        value={enabled === undefined ? "" : isOn ? "on" : "off"}
        onValueChange={(value) => {
          if (value) void onChange("image_gen.enabled", value === "on");
        }}
        disabled={disabled}
        spacing={1}
        className="rounded-lg bg-muted/40 p-1"
      >
        <ToggleGroupItem value="on" aria-label="image generation on" className={toggleClass}>
          on
        </ToggleGroupItem>
        <ToggleGroupItem value="off" aria-label="image generation off" className={toggleClass}>
          off
        </ToggleGroupItem>
      </ToggleGroup>
      <div className="mt-4 grid gap-4">
        <div className="flex flex-col gap-2">
          <span className="font-serif text-sm text-foreground">primary model</span>
          <ModelRefInput
            value={model}
            placeholder="openrouter/google/gemini-2.5-flash-image"
            allowEmpty={false}
            disabled={fieldsDisabled}
            onCommit={(next) => onChange("image_gen.model", next)}
          />
          <p className="font-serif text-xs italic text-muted-foreground/70">
            format: provider/model-id
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <span className="font-serif text-sm text-foreground">fallback model</span>
          <ModelRefInput
            value={fallbackModel}
            placeholder="none"
            allowEmpty
            disabled={fieldsDisabled}
            onCommit={(next) => onChange("image_gen.fallback_model", next)}
          />
          <p className="font-serif text-xs italic text-muted-foreground/70">
            leave empty for no fallback
          </p>
        </div>
      </div>
    </>
  );
}
