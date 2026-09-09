import { useState } from "react";
import { Popover } from "radix-ui";
import { useAgentSettings } from "@/lib/useAgentSettings";
import { THINKING_ORDER } from "@/lib/thinkingLevels";
import { focusPanel } from "@/lib/focusPanel";
import { byGateway, modelLeaf, modelRoute } from "@/lib/modelRoutes";
import { IconArrow, IconSwitch } from "./organicIcons";

export function QuickSettings({ channelKey, onOpenSettings }: { channelKey?: string; onOpenSettings: () => void }) {
  const settings = useAgentSettings(channelKey);
  const [open, setOpen] = useState(false);
  const model = settings.data?.model.value;
  const busy = !settings.data || settings.isMutating || settings.isLoading;
  const models = Array.from(new Set([...(model ? [model] : []), ...settings.models]));
  const supported = settings.data?.supportedThinking ?? [];
  const levels = THINKING_ORDER.filter((level) => supported.includes(level));
  const groups = byGateway(models);

  const row = (item: string) => {
    const route = modelRoute(item, groups.length > 0);
    return (
      <button key={item} type="button" role="radio" className="qs-model" aria-checked={item === model} disabled={busy} title={item} onClick={() => void settings.setModel(item)}>
        <span className="qs-radio" />
        <span className="qs-name">{modelLeaf(item)}</span>
        {route && <span className="qs-route">{route}</span>}
      </button>
    );
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void settings.refetch();
      }}
    >
      <Popover.Trigger className="switch-model-button" aria-label="switch model" title={model ?? "switch model"}>
        <IconSwitch size={15} />
        <span className="label-desktop">switch model</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="chat-theme quick-settings" align="end" sideOffset={12} collisionPadding={12} onOpenAutoFocus={focusPanel}>
          <span className="qs-handle" aria-hidden="true" />
          {settings.error && <p role="alert" className="qs-error">{settings.error}</p>}
          <div className="qs-block">
            <span className="qs-label">model</span>
            <div className="qs-models" role="radiogroup" aria-label="model">
              {models.length === 0 && <span className="qs-empty">{settings.isLoading ? "loading…" : "no models yet"}</span>}
              {groups.length > 0
                ? groups.map(({ gateway, models: list }) => (
                    <div key={gateway} className="qs-group">
                      <span className="qs-route-head">{gateway}</span>
                      {list.map(row)}
                    </div>
                  ))
                : models.map(row)}
            </div>
          </div>
          <div className="qs-block">
            <span className="qs-label">thinking</span>
            <div className="qs-pills">
              {levels.map((level) => (
                <button key={level} type="button" className="qs-pill" aria-pressed={settings.data?.thinking.value === level} disabled={busy} onClick={() => void settings.setThinking(level)}>
                  {level}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="qs-all"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            all settings
            <IconArrow size={14} />
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
