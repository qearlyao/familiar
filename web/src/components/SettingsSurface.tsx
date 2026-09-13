import { useState, type ReactNode } from "react";
import { ModelSection } from "./config/ModelSection";
import { ThinkingSection } from "./config/ThinkingSection";
import { HeartbeatSection } from "./config/HeartbeatSection";
import { ImageGenSection } from "./config/ImageGenSection";
import { MemorySection } from "./config/MemorySection";
import { TtsSection } from "./config/TtsSection";
import { DevicesSection } from "./config/DevicesSection";
import { ReachCard, RepliesCard } from "./config/ChannelsSection";
import { useAgentSettings } from "@/lib/useAgentSettings";
import { useConfig } from "@/lib/useConfig";
import { useDevices } from "@/lib/useDevices";
import { modelLeaf } from "@/lib/modelRoutes";
import type { WebAuthDevice } from "@/lib/api";
import { IconX } from "./organicIcons";
import "./settings.css";

type TabId = "mind" | "reach" | "voice" | "devices";

export function SettingsSurface({
  channelKey,
  channelLabel,
  authMode,
  authDevice,
  onSignedOut,
  onClose,
}: {
  channelKey: string | undefined;
  channelLabel?: string;
  authMode?: string;
  authDevice?: WebAuthDevice;
  onSignedOut?: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabId>("mind");
  const agent = useAgentSettings(channelKey);
  const config = useConfig(true);
  const showDevices = authMode === "bearer" && !!onSignedOut;
  const devices = useDevices(showDevices, authDevice);
  const values = config.data?.values;
  const ready = Boolean(agent.data) && Boolean(config.data);
  const busy = agent.isLoading || agent.isMutating || config.isLoading || config.isMutating;
  const disabled = !ready || busy;
  const error = agent.error ?? config.error;
  const overridden = agent.data?.model.source === "override" || agent.data?.thinking.source === "override";
  const here = channelLabel ?? "this channel";

  const tabs: { id: TabId; label: string; sub: string }[] = [
    { id: "mind", label: "how they think", sub: agent.data ? modelLeaf(agent.data.model.value) : "…" },
    { id: "reach", label: "how they reach you", sub: values ? `heartbeat ${values["heartbeat.enabled"].value ? "on" : "off"}` : "…" },
    { id: "voice", label: "voice and pictures", sub: values ? (values["tts.provider"].value === "cartesia" ? "cartesia" : "11labs") : "…" },
    ...(showDevices ? [{ id: "devices" as const, label: "devices", sub: `${devices.devices.length} signed in` }] : []),
  ];

  let page: ReactNode = null;
  switch (tab) {
    case "mind":
      page = (
        <>
          <ModelSection
            models={agent.models}
            added={agent.addedModels}
            current={agent.data?.model.value}
            disabled={disabled}
            onChange={(model) => void agent.setModel(model)}
            onAdd={agent.addModel}
            onRemove={agent.removeModel}
          />
          <div className="settings-column">
            <ThinkingSection current={agent.data?.thinking.value} supported={agent.data?.supportedThinking ?? []} disabled={disabled} onChange={(level) => void agent.setThinking(level)} />
            <MemorySection values={values} models={agent.models} disabled={disabled} onChange={config.setConfig} onClear={config.clearConfig} />
          </div>
        </>
      );
      break;
    case "reach":
      page = (
        <>
          <div className="settings-column">
            <HeartbeatSection values={values} disabled={disabled} onChange={config.setConfig} />
            <ReachCard values={values} disabled={disabled} onChange={config.setConfig} />
          </div>
          <RepliesCard values={values} disabled={disabled} onChange={config.setConfig} />
        </>
      );
      break;
    case "voice":
      page = (
        <>
          <TtsSection values={values} disabled={disabled} onChange={config.setConfig} />
          <ImageGenSection values={values} disabled={disabled} onChange={config.setConfig} />
        </>
      );
      break;
    case "devices":
      page = onSignedOut && <DevicesSection state={devices} onSignedOut={onSignedOut} />;
      break;
  }

  return (
    <div className="settings">
      <header className="settings-head">
        <div>
          <h2>settings</h2>
          <span>
            saved as you go<span className="settings-restart"> · discord and qq need a restart</span>
          </span>
        </div>
        <button type="button" className="settings-close" title="back to the conversation" aria-label="back to the conversation" onClick={onClose}>
          <IconX />
        </button>
      </header>
      <div className="settings-tabs-rail">
        <div className="settings-tabs" role="tablist" aria-label="settings pages">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" id={`settings-tab-${t.id}`} className="settings-tab" aria-selected={t.id === tab} onClick={(event) => {
                setTab(t.id);
                event.currentTarget.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
              }}
            >
              <span>{t.label}</span>
              <small>{t.sub}</small>
            </button>
          ))}
        </div>
      </div>
      <div key={tab} className="settings-body" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
        {tab === "mind" && agent.data && (
          <p className="settings-source">
            <span>
              {overridden ? "set for this channel" : "from the default config"}
              <code>{here}</code>
            </span>
            {overridden ? `model and thinking here apply to ${here} only — nothing here touches your other channels.` : `pick a model or thinking level and it applies to ${here} only.`}
          </p>
        )}
        {error && (
          <p role="alert" className="settings-error">
            {error}
          </p>
        )}
        <div className="settings-page">{page}</div>
      </div>
    </div>
  );
}
