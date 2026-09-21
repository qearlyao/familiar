import type { ConfigKey, ConfigValues } from "@/lib/api";
import { Card, EnumToggle, NumberInput, OnOffToggle, Row, Rows } from "./inputs";
import { NotificationsRow } from "./NotificationsRow";

const DISPATCH_OPTIONS = [
  { value: "queue", label: "queue" },
  { value: "collect", label: "collect" },
  { value: "steer", label: "steer" },
] as const;

const TRIGGER_OPTIONS = [
  { value: "mention", label: "on mention" },
  { value: "always", label: "every message" },
] as const;

interface Props {
  values: ConfigValues | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}

export function ReachCard({ values, disabled, onChange }: Props) {
  const connection = (key: "discord.enabled" | "qq.enabled", label: string) => (
    <Row label={label} help="needs a restart to take effect.">
      <OnOffToggle enabled={values?.[key].value} disabled={disabled} ariaPrefix={label} onChange={(next) => void onChange(key, next)} />
    </Row>
  );
  return (
    <Card title="where they reach you" hint="if discord already reaches you here, leave the last one off.">
      <Rows>
        {connection("discord.enabled", "discord")}
        {connection("qq.enabled", "qq")}
        <NotificationsRow />
      </Rows>
    </Card>
  );
}

export function RepliesCard({ values, disabled, onChange }: Props) {
  return (
    <Card title="how they reply">
      <Rows>
        <Row label="in dms">
          <EnumToggle value={values?.["discord.dm_mode"].value} options={DISPATCH_OPTIONS} ariaPrefix="dm reply mode" disabled={disabled} onChange={(next) => void onChange("discord.dm_mode", next)} />
        </Row>
        <Row label="in channels and groups">
          <EnumToggle value={values?.["discord.channel_mode"].value} options={DISPATCH_OPTIONS} ariaPrefix="channel reply mode" disabled={disabled} onChange={(next) => void onChange("discord.channel_mode", next)} />
        </Row>
        <Row label="in channels they answer">
          <EnumToggle value={values?.["discord.channel_trigger"].value} options={TRIGGER_OPTIONS} ariaPrefix="channel trigger" disabled={disabled} onChange={(next) => void onChange("discord.channel_trigger", next)} />
        </Row>
        <Row label="collect window ms" help="how long they wait for more to arrive.">
          <NumberInput value={values?.["discord.collect_debounce_ms"].value} min={1} step={100} disabled={disabled} onCommit={(v) => onChange("discord.collect_debounce_ms", v)} />
        </Row>
      </Rows>
      <p className="settings-note">queue answers each message in turn. collect folds messages that arrive together into one reply. steer lets a new message redirect a reply already underway.</p>
    </Card>
  );
}
