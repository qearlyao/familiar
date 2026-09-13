import type { ConfigKey, ConfigValues } from "@/lib/api";
import { Card, MinuteInput, OnOffToggle, Sentence, Unit } from "./inputs";

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
  const off = disabled || enabled !== true;
  return (
    <Card title="heartbeat" off={enabled !== true} action={<OnOffToggle enabled={enabled} disabled={disabled} ariaPrefix="heartbeat" onChange={(next) => void onChange("heartbeat.enabled", next)} />}>
      <Sentence>
        wakes after{" "}
        <Unit>
          <MinuteInput valueMs={values?.["heartbeat.idleThresholdMs"].value} disabled={off} onCommit={(ms) => onChange("heartbeat.idleThresholdMs", ms)} /> min
        </Unit>{" "}
        of quiet, then every{" "}
        <Unit>
          <MinuteInput valueMs={values?.["heartbeat.intervalMs"].value} disabled={off} onCommit={(ms) => onChange("heartbeat.intervalMs", ms)} /> min
        </Unit>{" "}
        while you stay away.
      </Sentence>
    </Card>
  );
}
