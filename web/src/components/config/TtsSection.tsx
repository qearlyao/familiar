import type { ConfigKey, ConfigValues } from "@/lib/api";
import { EnumToggle, Field, TextInput } from "./inputs";

export function TtsSection({
  values,
  disabled,
  onChange,
}: {
  values: ConfigValues | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}) {
  const provider = values?.["tts.provider"].value;
  const cartesia = provider === "cartesia";
  const voiceKey = cartesia ? "tts.cartesia.voice_id" : "tts.voice_id";
  const modelKey = cartesia ? "tts.cartesia.model_id" : "tts.model_id";
  return (
    <>
      <div className="settings-card">
        <div className="settings-card-head">
          <div className="settings-block-title">
            <span>their voice</span>
            <span>who speaks for them, and with which ids.</span>
          </div>
          <EnumToggle
            value={provider}
            options={[
              { value: "elevenlabs", label: "11labs" },
              { value: "cartesia", label: "cartesia" },
            ]}
            ariaPrefix="tts provider"
            disabled={disabled}
            onChange={(next) => void onChange("tts.provider", next)}
          />
        </div>
        <div className="settings-grid is-wide">
          <Field label="voice id">
            <TextInput value={values?.[voiceKey].value} placeholder="not set" allowEmpty disabled={disabled} onCommit={(next) => onChange(voiceKey, next)} />
          </Field>
          <Field label="model id">
            <TextInput value={values?.[modelKey].value} placeholder={cartesia ? "sonic-3.5" : "eleven_v3"} disabled={disabled} onCommit={(next) => onChange(modelKey, next)} />
          </Field>
          {!cartesia && (
            <Field label="model id on a call" hint="a faster model keeps the call moving">
              <TextInput value={values?.["tts.voice_call_model_id"].value} placeholder="eleven_v3_conversational" disabled={disabled} onCommit={(next) => onChange("tts.voice_call_model_id", next)} />
            </Field>
          )}
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-head">
          <div className="settings-block-title">
            <span>on a call</span>
            <span>continuous listens the whole time. push to talk only listens while you hold the button.</span>
          </div>
          <EnumToggle
            value={values?.["web.voice_call_mode"].value}
            options={[
              { value: "continuous", label: "continuous" },
              { value: "push_to_talk", label: "push to talk" },
            ]}
            ariaPrefix="voice call input"
            disabled={disabled}
            onChange={(next) => void onChange("web.voice_call_mode", next)}
          />
        </div>
      </div>
    </>
  );
}
