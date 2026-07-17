import type { ConfigKey, ConfigValues } from "@/lib/api";
import { TextInput } from "./inputs";

interface TtsSectionProps {
  values: ConfigValues | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}

export function TtsSection({ values, disabled, onChange }: TtsSectionProps) {
  return (
    <div className="grid gap-4">
      <label className="flex flex-col gap-2 font-serif text-sm text-foreground">
        voice id
        <TextInput
          value={values?.["tts.voice_id"].value}
          placeholder="not set"
          allowEmpty
          disabled={disabled}
          onCommit={(next) => onChange("tts.voice_id", next)}
        />
      </label>
      <label className="flex flex-col gap-2 font-serif text-sm text-foreground">
        model id
        <TextInput
          value={values?.["tts.model_id"].value}
          placeholder="eleven_v3"
          disabled={disabled}
          onCommit={(next) => onChange("tts.model_id", next)}
        />
      </label>
    </div>
  );
}
