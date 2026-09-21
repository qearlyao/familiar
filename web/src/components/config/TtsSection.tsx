import type { ConfigKey, ConfigValues } from "@/lib/api";
import { Card, EnumToggle, NumberInput, Row, Rows, TextInput } from "./inputs";

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
    <Card title="their voice">
      <Rows>
        <Row label="provider">
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
        </Row>
        <Row label="voice id">
          <TextInput value={values?.[voiceKey].value} placeholder="not set" allowEmpty disabled={disabled} onCommit={(next) => onChange(voiceKey, next)} />
        </Row>
        <Row label="model id">
          <TextInput value={values?.[modelKey].value} placeholder={cartesia ? "sonic-3.5" : "eleven_v3"} disabled={disabled} onCommit={(next) => onChange(modelKey, next)} />
        </Row>
        {!cartesia && (
          <Row label="model id on a call" help="a faster model keeps a call moving.">
            <TextInput value={values?.["tts.voice_call_model_id"].value} placeholder="eleven_v3_conversational" disabled={disabled} onCommit={(next) => onChange("tts.voice_call_model_id", next)} />
          </Row>
        )}
      </Rows>
    </Card>
  );
}

/** a call is its own conversation: how much of the chat it starts with, and what it leaves behind */
export function VoiceCallSection({
  values,
  disabled,
  onChange,
}: {
  values: ConfigValues | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}) {
  return (
    <Card title="on a call">
      <Rows>
        <Row label="chat context messages" help="how much of the chat a call starts with.">
          <NumberInput value={values?.["web.voice_context_messages"].value} min={0} max={200} disabled={disabled} onCommit={(next) => onChange("web.voice_context_messages", next)} />
        </Row>
        <Row label="after you hang up">
          <EnumToggle
            value={values?.["web.voice_keep"].value}
            options={[
              { value: "ask", label: "ask" },
              { value: "transcript", label: "transcript" },
              { value: "summary", label: "summary" },
              { value: "discard", label: "discard" },
            ]}
            ariaPrefix="after a call"
            disabled={disabled}
            onChange={(next) => void onChange("web.voice_keep", next)}
          />
        </Row>
      </Rows>
      <p className="settings-note">a summary is written by the same model that folds long chats into memory.</p>
    </Card>
  );
}
