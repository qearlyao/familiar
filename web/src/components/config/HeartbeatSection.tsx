import type { ConfigKey, ConfigValues } from "@/lib/api";
import { Card, MinuteInput, OnOffToggle, Row, Rows } from "./inputs";

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
    <Card
      title="heartbeat"
      hint="checking in while you are away."
      off={enabled !== true}
      action={<OnOffToggle enabled={enabled} disabled={disabled} labelled ariaPrefix="heartbeat" onChange={(next) => void onChange("heartbeat.enabled", next)} />}
    >
      <Rows>
        <Row label="idle minutes" help="quiet time before the first look in.">
          <MinuteInput valueMs={values?.["heartbeat.idleThresholdMs"].value} disabled={off} onCommit={(ms) => onChange("heartbeat.idleThresholdMs", ms)} />
        </Row>
        <Row label="interval minutes" help="how long between looks after that.">
          <MinuteInput valueMs={values?.["heartbeat.intervalMs"].value} disabled={off} onCommit={(ms) => onChange("heartbeat.intervalMs", ms)} />
        </Row>
      </Rows>
    </Card>
  );
}
