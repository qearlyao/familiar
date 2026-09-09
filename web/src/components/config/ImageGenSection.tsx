import type { ConfigKey, ConfigValues } from "@/lib/api";
import { ModelRefInput, OnOffToggle } from "./inputs";

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
    <div className="settings-card">
      <div className="settings-card-head">
        <div className="settings-block-title">
          <span>image generation</span>
          <span>which model they use to paint.</span>
        </div>
        <OnOffToggle enabled={enabled} disabled={disabled} ariaPrefix="image generation" onChange={(next) => void onChange("image_gen.enabled", next)} />
      </div>
      <div className="settings-block">
        <div className="settings-block-title">
          <span>primary model</span>
          <span>format: provider/model-id</span>
        </div>
        <ModelRefInput value={values?.["image_gen.model"].value} placeholder="openrouter/google/gemini-2.5-flash-image" allowEmpty={false} disabled={fieldsDisabled} onCommit={(next) => onChange("image_gen.model", next)} />
      </div>
      <div className="settings-block">
        <div className="settings-block-title">
          <span>fallback model</span>
          <span>leave empty for no fallback</span>
        </div>
        <ModelRefInput value={values?.["image_gen.fallback_model"].value} placeholder="none" allowEmpty disabled={fieldsDisabled} onCommit={(next) => onChange("image_gen.fallback_model", next)} />
      </div>
    </div>
  );
}
