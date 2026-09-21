import type { ConfigKey, ConfigValues } from "@/lib/api";
import { Card, MODEL_REF, OnOffToggle, Row, Rows, TextInput } from "./inputs";

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
  const off = disabled || enabled !== true;
  return (
    <Card
      title="pictures"
      off={enabled !== true}
      action={<OnOffToggle enabled={enabled} disabled={disabled} labelled ariaPrefix="image generation" onChange={(next) => void onChange("image_gen.enabled", next)} />}
    >
      <Rows>
        <Row label="primary model">
          <TextInput pattern={MODEL_REF} value={values?.["image_gen.model"].value} placeholder="openrouter/google/gemini-2.5-flash-image" allowEmpty={false} disabled={off} onCommit={(next) => onChange("image_gen.model", next)} />
        </Row>
        <Row label="fallback model" help="leave it empty for none.">
          <TextInput pattern={MODEL_REF} value={values?.["image_gen.fallback_model"].value} placeholder="none" allowEmpty disabled={off} onCommit={(next) => onChange("image_gen.fallback_model", next)} />
        </Row>
      </Rows>
    </Card>
  );
}
