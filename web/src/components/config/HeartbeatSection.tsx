import { useEffect, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ConfigKey } from "@/lib/api";

interface HeartbeatSectionProps {
  enabled: boolean | undefined;
  idleThresholdMs: number | undefined;
  intervalMs: number | undefined;
  disabled: boolean;
  onChange: (key: ConfigKey, value: unknown) => Promise<void>;
}

const MS_PER_MIN = 60_000;

const toggleClass =
  "h-9 rounded-md px-3.5 text-sm lowercase text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary";

function MinuteInput({
  valueMs,
  disabled,
  onCommit,
}: {
  valueMs: number | undefined;
  disabled: boolean;
  onCommit: (ms: number) => Promise<void>;
}) {
  const minutes = valueMs === undefined ? "" : String(Math.round(valueMs / MS_PER_MIN));
  const [draft, setDraft] = useState<string>(minutes);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(minutes);
  }, [minutes]);

  const commit = async () => {
    const parsed = Number.parseInt(draft, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      setDraft(minutes);
      return;
    }
    const nextMs = parsed * MS_PER_MIN;
    if (nextMs === valueMs) return;
    setBusy(true);
    try {
      await onCommit(nextMs);
    } catch {
      setDraft(minutes);
    } finally {
      setBusy(false);
    }
  };

  return (
    <input
      type="number"
      inputMode="numeric"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      disabled={disabled || busy}
      min={1}
      className="h-8 w-16 rounded-md border border-border bg-background px-2 font-mono text-sm text-right text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
    />
  );
}

export function HeartbeatSection({
  enabled,
  idleThresholdMs,
  intervalMs,
  disabled,
  onChange,
}: HeartbeatSectionProps) {
  const isOn = enabled === true;
  return (
    <>
      <ToggleGroup
        type="single"
        value={enabled === undefined ? "" : isOn ? "on" : "off"}
        onValueChange={(value) => {
          if (value) void onChange("heartbeat.enabled", value === "on");
        }}
        disabled={disabled}
        spacing={1}
        className="rounded-lg bg-muted/40 p-1"
      >
        <ToggleGroupItem value="on" aria-label="heartbeat on" className={toggleClass}>
          on
        </ToggleGroupItem>
        <ToggleGroupItem value="off" aria-label="heartbeat off" className={toggleClass}>
          off
        </ToggleGroupItem>
      </ToggleGroup>
      <div className="mt-4 grid gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <span className="flex-1 font-serif text-sm text-foreground">first wakeup after</span>
            <MinuteInput
              valueMs={idleThresholdMs}
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
              valueMs={intervalMs}
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
