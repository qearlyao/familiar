import type { ConfigKey, ConfigValues } from "@/lib/api";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TextInput, toggleClass } from "./inputs";

interface TtsSectionProps {
  values: ConfigValues | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}

export function TtsSection({ values, disabled, onChange }: TtsSectionProps) {
  const provider = values?.["tts.provider"].value;
  const cartesia = provider === "cartesia";
  const voiceKey = cartesia ? "tts.cartesia.voice_id" : "tts.voice_id";
  const modelKey = cartesia ? "tts.cartesia.model_id" : "tts.model_id";
  return (
    <div className="grid gap-4">
      <label className="flex flex-col gap-2 font-serif text-sm text-foreground">
        provider
        <ToggleGroup
          type="single"
          value={provider ?? ""}
          onValueChange={(next) => {
            if (next) void onChange("tts.provider", next);
          }}
          disabled={disabled}
          spacing={1}
          className="w-fit rounded-lg bg-muted/40 p-1"
        >
          <ToggleGroupItem value="elevenlabs" aria-label="tts provider elevenlabs" className={toggleClass}>
            11labs
          </ToggleGroupItem>
          <ToggleGroupItem value="cartesia" aria-label="tts provider cartesia" className={toggleClass}>
            cartesia
          </ToggleGroupItem>
        </ToggleGroup>
      </label>
      <label className="flex flex-col gap-2 font-serif text-sm text-foreground">
        voice id
        <TextInput
          value={values?.[voiceKey].value}
          placeholder="not set"
          allowEmpty
          disabled={disabled}
          onCommit={(next) => onChange(voiceKey, next)}
        />
      </label>
      <label className="flex flex-col gap-2 font-serif text-sm text-foreground">
        model id
        <TextInput
          value={values?.[modelKey].value}
          placeholder={cartesia ? "sonic-3.5" : "eleven_v3"}
          disabled={disabled}
          onCommit={(next) => onChange(modelKey, next)}
        />
      </label>
    </div>
  );
}
