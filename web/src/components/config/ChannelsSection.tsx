import type { ConfigKey, ConfigValues } from "@/lib/api";
import { EnumToggle, NumberInput, OnOffToggle } from "./inputs";

interface ChannelsSectionProps {
  values: ConfigValues | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}

const DISPATCH_OPTIONS = [
  { value: "queue", label: "queue" },
  { value: "collect", label: "collect" },
  { value: "steer", label: "steer" },
] as const;

const TRIGGER_OPTIONS = [
  { value: "mention", label: "mentions" },
  { value: "always", label: "every message" },
] as const;

export function ChannelsSection({ values, disabled, onChange }: ChannelsSectionProps) {
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <span className="flex-1 font-serif text-sm text-foreground">discord</span>
        <OnOffToggle
          enabled={values?.["discord.enabled"].value}
          disabled={disabled}
          ariaPrefix="discord"
          onChange={(next) => void onChange("discord.enabled", next)}
        />
      </div>
      <div className="flex items-center gap-3">
        <span className="flex-1 font-serif text-sm text-foreground">qq</span>
        <OnOffToggle
          enabled={values?.["qq.enabled"].value}
          disabled={disabled}
          ariaPrefix="qq"
          onChange={(next) => void onChange("qq.enabled", next)}
        />
      </div>
      <div className="mt-4 grid gap-4 border-t border-border/60 pt-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 font-serif text-sm text-foreground">dm reply mode</span>
            <EnumToggle
              value={values?.["discord.dm_mode"].value}
              options={DISPATCH_OPTIONS}
              ariaPrefix="dm reply mode"
              disabled={disabled}
              onChange={(next) => void onChange("discord.dm_mode", next)}
            />
          </div>
          <p className="font-serif text-xs italic text-muted-foreground/70">
            queue: each message waits its turn. collect: messages arriving together are answered as one
            reply. steer: a message while a reply is in progress redirects it. applies to discord, qq,
            and the web main chat.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 font-serif text-sm text-foreground">channel reply mode</span>
            <EnumToggle
              value={values?.["discord.channel_mode"].value}
              options={DISPATCH_OPTIONS}
              ariaPrefix="channel reply mode"
              disabled={disabled}
              onChange={(next) => void onChange("discord.channel_mode", next)}
            />
          </div>
          <p className="font-serif text-xs italic text-muted-foreground/70">
            how replies behave in servers, channels, and group chats. same choices as dm. this one
            applies to discord and qq only.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 font-serif text-sm text-foreground">respond when</span>
            <EnumToggle
              value={values?.["discord.channel_trigger"].value}
              options={TRIGGER_OPTIONS}
              ariaPrefix="channel trigger"
              disabled={disabled}
              onChange={(next) => void onChange("discord.channel_trigger", next)}
            />
          </div>
          <p className="font-serif text-xs italic text-muted-foreground/70">
            mentions: only when named. every message: whatever the conversation brings.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 font-serif text-sm text-foreground">wait before replying</span>
            <NumberInput
              value={values?.["discord.collect_debounce_ms"].value}
              min={1}
              step={100}
              disabled={disabled}
              onCommit={(v) => onChange("discord.collect_debounce_ms", v)}
            />
            <span className="font-serif text-xs italic text-muted-foreground">ms</span>
          </div>
          <p className="font-serif text-xs italic text-muted-foreground/70">
            how long batched replies hold for more messages
          </p>
        </div>
        <p className="font-serif text-xs italic text-muted-foreground/70">
          reply modes and the debounce take effect on the next message, no restart needed. the discord
          and qq connection toggles still need a restart.
        </p>
      </div>
    </div>
  );
}
