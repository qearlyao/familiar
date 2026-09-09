import type { ConfigKey, ConfigValues } from "@/lib/api";
import { EnumToggle, Field, NumberInput, OnOffToggle, Sentence } from "./inputs";

const DISPATCH_OPTIONS = [
  { value: "queue", label: "queue" },
  { value: "collect", label: "collect" },
  { value: "steer", label: "steer" },
] as const;

const TRIGGER_OPTIONS = [
  { value: "mention", label: "mentions" },
  { value: "always", label: "every message" },
] as const;

export function ChannelsSection({
  values,
  disabled,
  onChange,
}: {
  values: ConfigValues | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}) {
  return (
    <>
      <div className="settings-card">
        <div className="settings-card-head">
          <div className="settings-block-title">
            <span>connections</span>
            <span>where else they can be reached. these two need a restart.</span>
          </div>
        </div>
        <div className="settings-row">
          <span>discord</span>
          <OnOffToggle enabled={values?.["discord.enabled"].value} disabled={disabled} ariaPrefix="discord" onChange={(next) => void onChange("discord.enabled", next)} />
        </div>
        <div className="settings-row">
          <span>qq</span>
          <OnOffToggle enabled={values?.["qq.enabled"].value} disabled={disabled} ariaPrefix="qq" onChange={(next) => void onChange("qq.enabled", next)} />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-head">
          <div className="settings-block-title">
            <span>how they reply</span>
            <span>takes effect from the next message.</span>
          </div>
        </div>
        <div className="settings-columns">
          <Field label="in dms" hint="discord, qq and the main chat here">
            <EnumToggle value={values?.["discord.dm_mode"].value} options={DISPATCH_OPTIONS} ariaPrefix="dm reply mode" disabled={disabled} onChange={(next) => void onChange("discord.dm_mode", next)} />
          </Field>
          <Field label="in channels and groups" hint="discord and qq only">
            <EnumToggle
              value={values?.["discord.channel_mode"].value}
              options={DISPATCH_OPTIONS}
              ariaPrefix="channel reply mode"
              disabled={disabled}
              onChange={(next) => void onChange("discord.channel_mode", next)}
            />
          </Field>
        </div>
        <p className="settings-note">
          queue answers each message in turn. collect folds messages that arrive together into one reply. steer lets a new message redirect a reply already underway.
        </p>
        <Field label="in channels, they answer">
          <EnumToggle
            value={values?.["discord.channel_trigger"].value}
            options={TRIGGER_OPTIONS}
            ariaPrefix="channel trigger"
            disabled={disabled}
            onChange={(next) => void onChange("discord.channel_trigger", next)}
          />
        </Field>
        <Sentence>
          when collecting, they wait{" "}
          <NumberInput value={values?.["discord.collect_debounce_ms"].value} min={1} step={100} inline disabled={disabled} onCommit={(v) => onChange("discord.collect_debounce_ms", v)} /> ms for more to arrive.
        </Sentence>
      </div>
    </>
  );
}
