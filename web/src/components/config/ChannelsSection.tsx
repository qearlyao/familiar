import type { ConfigKey, ConfigValues } from "@/lib/api";
import { OnOffToggle } from "./inputs";

interface ChannelsSectionProps {
  values: ConfigValues | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}

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
      <p className="font-serif text-xs italic text-muted-foreground/70">
        changes take effect after familiar restarts.
      </p>
    </div>
  );
}
