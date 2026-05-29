import type { ConfigKey, ConfigValues } from "@/lib/api";
import { ModelRefInput, OnOffToggle } from "./inputs";

interface ImageGenSectionProps {
  values: ConfigValues | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}

export function ImageGenSection({ values, disabled, onChange }: ImageGenSectionProps) {
  const enabled = values?.["image_gen.enabled"].value;
  const isOn = enabled === true;
  const fieldsDisabled = disabled || !isOn;
  return (
    <>
      <OnOffToggle
        enabled={enabled}
        disabled={disabled}
        ariaPrefix="image generation"
        onChange={(next) => void onChange("image_gen.enabled", next)}
      />
      <div className="mt-4 grid gap-4">
        <div className="flex flex-col gap-2">
          <span className="font-serif text-sm text-foreground">primary model</span>
          <ModelRefInput
            value={values?.["image_gen.model"].value}
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
            value={values?.["image_gen.fallback_model"].value}
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
