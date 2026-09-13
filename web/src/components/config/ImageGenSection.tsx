import type { ConfigKey, ConfigValues } from "@/lib/api";
import { Card, Field, ModelRefInput, OnOffToggle } from "./inputs";

export function ImageGenSection({
  values,
  disabled,
  onChange,
}: {
  values: ConfigValues | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}) {
  const enabled = values?.["image_gen.enabled"].value;
  const fieldsDisabled = disabled || enabled !== true;
  return (
    <Card title="pictures" off={enabled !== true} action={<OnOffToggle enabled={enabled} disabled={disabled} ariaPrefix="image generation" onChange={(next) => void onChange("image_gen.enabled", next)} />}>
      <Field label="primary · provider/model-id">
        <ModelRefInput value={values?.["image_gen.model"].value} placeholder="openrouter/google/gemini-2.5-flash-image" allowEmpty={false} disabled={fieldsDisabled} onCommit={(next) => onChange("image_gen.model", next)} />
      </Field>
      <Field label="fallback · empty for none">
        <ModelRefInput value={values?.["image_gen.fallback_model"].value} placeholder="none" allowEmpty disabled={fieldsDisabled} onCommit={(next) => onChange("image_gen.fallback_model", next)} />
      </Field>
    </Card>
  );
}
