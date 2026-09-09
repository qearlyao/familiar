import type { ConfigKey, ConfigValues } from "@/lib/api";
import { MinuteInput, OnOffToggle, Sentence } from "./inputs";

export function HeartbeatSection({
  values,
  disabled,
  onChange,
}: {
  values: ConfigValues | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}) {
  const enabled = values?.["heartbeat.enabled"].value;
  const isOn = enabled === true;
  return (
    <div className={isOn ? "settings-card" : "settings-card is-off"}>
      <div className="settings-card-head">
        <div className="settings-block-title">
          <span>heartbeat</span>
          <span>their pulse when you've gone quiet.</span>
        </div>
        <OnOffToggle enabled={enabled} disabled={disabled} ariaPrefix="heartbeat" onChange={(next) => void onChange("heartbeat.enabled", next)} />
      </div>
      <Sentence>
        wakes after <MinuteInput valueMs={values?.["heartbeat.idleThresholdMs"].value} disabled={disabled || !isOn} onCommit={(ms) => onChange("heartbeat.idleThresholdMs", ms)} /> minutes of quiet, then every{" "}
        <MinuteInput valueMs={values?.["heartbeat.intervalMs"].value} disabled={disabled || !isOn} onCommit={(ms) => onChange("heartbeat.intervalMs", ms)} /> minutes while you stay away.
      </Sentence>
    </div>
  );
}
