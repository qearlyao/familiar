import type { ConfigKey, ConfigValues } from "@/lib/api";
import { MinuteInput, OnOffToggle } from "./inputs";

interface HeartbeatSectionProps {
  values: ConfigValues | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}

export function HeartbeatSection({ values, disabled, onChange }: HeartbeatSectionProps) {
  const enabled = values?.["heartbeat.enabled"].value;
  const isOn = enabled === true;
  return (
    <>
      <OnOffToggle
        enabled={enabled}
        disabled={disabled}
        ariaPrefix="heartbeat"
        onChange={(next) => void onChange("heartbeat.enabled", next)}
      />
      <div className="mt-4 grid gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <span className="flex-1 font-serif text-sm text-foreground">first wakeup after</span>
            <MinuteInput
              valueMs={values?.["heartbeat.idleThresholdMs"].value}
              disabled={disabled || !isOn}
              onCommit={(ms) => onChange("heartbeat.idleThresholdMs", ms)}
            />
            <span className="w-14 font-serif text-xs italic text-muted-foreground">minutes</span>
          </div>
          <p className="font-serif text-xs italic text-muted-foreground/70">
            minutes of silence before the first wakeup
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <span className="flex-1 font-serif text-sm text-foreground">between wakeups</span>
            <MinuteInput
              valueMs={values?.["heartbeat.intervalMs"].value}
              disabled={disabled || !isOn}
              onCommit={(ms) => onChange("heartbeat.intervalMs", ms)}
            />
            <span className="w-14 font-serif text-xs italic text-muted-foreground">minutes</span>
          </div>
          <p className="font-serif text-xs italic text-muted-foreground/70">
            cadence of subsequent wakeups while you stay quiet
          </p>
        </div>
      </div>
    </>
  );
}
