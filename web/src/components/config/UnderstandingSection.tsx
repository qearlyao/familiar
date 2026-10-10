import type { ConfigKey, ConfigValues } from "@/lib/api";
import { Card, Row, Rows, TextInput } from "./inputs";

export function UnderstandingSection({
  values,
  disabled,
  onChange,
}: {
  values: ConfigValues | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}) {
  const model = (key: "media.understanding.audio.model" | "media.understanding.video.model", placeholder: string) => (
    <TextInput value={values?.[key].value} placeholder={placeholder} disabled={disabled} onCommit={(next) => onChange(key, next)} />
  );
  return (
    <Card title="senses" hint="how voice notes and clips are understood">
      <Rows>
        <Row label="listening model" help="the provider lives in config.toml; this name has to be one it knows.">{model("media.understanding.audio.model", "whisper-large-v3")}</Row>
        <Row label="watching model" help="the provider lives in config.toml; this name has to be one it knows.">{model("media.understanding.video.model", "gemini-3-flash-preview")}</Row>
      </Rows>
    </Card>
  );
}
