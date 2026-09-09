import { useState, type ReactNode } from "react";
import { ModelSection } from "./config/ModelSection";
import { ThinkingSection } from "./config/ThinkingSection";
import { HeartbeatSection } from "./config/HeartbeatSection";
import { ImageGenSection } from "./config/ImageGenSection";
import { MemorySection } from "./config/MemorySection";
import { NotificationsSection } from "./config/NotificationsSection";
import { TtsSection } from "./config/TtsSection";
import { DevicesSection } from "./config/DevicesSection";
import { ChannelsSection } from "./config/ChannelsSection";
import { useAgentSettings } from "@/lib/useAgentSettings";
import { useConfig } from "@/lib/useConfig";
import type { WebAuthDevice } from "@/lib/api";
import {
  IconChevronDown,
  IconX,
  NavChannels,
  NavDevices,
  NavHeartbeat,
  NavImage,
  NavMemory,
  NavModel,
  NavNotifications,
  NavThinking,
  NavVoice,
} from "./organicIcons";

type SectionId = "model" | "thinking" | "heartbeat" | "voice" | "image" | "channels" | "memory" | "notifications" | "devices";

const SECTIONS: { id: SectionId; group: string; label: string; description: string; icon: typeof NavModel }[] = [
  { id: "model", group: "conversation", label: "model", description: "which language model carries this conversation.", icon: NavModel },
  { id: "thinking", group: "conversation", label: "thinking", description: "how long they deliberate before answering.", icon: NavThinking },
  { id: "heartbeat", group: "companion", label: "heartbeat", description: "their pulse when you've gone quiet.", icon: NavHeartbeat },
  { id: "voice", group: "companion", label: "voice", description: "which voice and model they speak with.", icon: NavVoice },
  { id: "image", group: "companion", label: "image generation", description: "which model they use to paint.", icon: NavImage },
  { id: "channels", group: "companion", label: "channels", description: "which discord and qq connections are running, and how they answer on each.", icon: NavChannels },
  { id: "memory", group: "companion", label: "memory", description: "how older conversation is condensed and how earlier memories return.", icon: NavMemory },
  { id: "notifications", group: "room", label: "notifications", description: "a word from this device when you're away.", icon: NavNotifications },
  { id: "devices", group: "room", label: "devices", description: "where this web room is still open.", icon: NavDevices },
];

const GROUPS = [...new Set(SECTIONS.map((s) => s.group))];

export function SettingsSurface({
  channelKey,
  authMode,
  authDevice,
  onSignedOut,
  onClose,
}: {
  channelKey: string | undefined;
  authMode?: string;
  authDevice?: WebAuthDevice;
  onSignedOut?: () => void;
  onClose: () => void;
}) {
  const [section, setSection] = useState<SectionId>("model");
  const [detail, setDetail] = useState(false); // phones: list first, then the chosen panel
  const agent = useAgentSettings(channelKey);
  const config = useConfig(true);
  const values = config.data?.values;
  const ready = Boolean(agent.data) && Boolean(config.data);
  const busy = agent.isLoading || agent.isMutating || config.isLoading || config.isMutating;
  const disabled = !ready || busy;
  const error = agent.error ?? config.error;
  const showDevices = authMode === "bearer" && !!onSignedOut;
  const visible = SECTIONS.filter((s) => s.id !== "devices" || showDevices);
  const current = visible.find((s) => s.id === section) ?? visible[0];
  const channelCount = [values?.["discord.enabled"].value, values?.["qq.enabled"].value].filter((v) => v === true).length;
  const source = current.id === "model" ? agent.data?.model.source : current.id === "thinking" ? agent.data?.thinking.source : undefined;

  let body: ReactNode = null;
  switch (current.id) {
    case "model":
      body = (
        <ModelSection
          models={agent.models}
          added={agent.addedModels}
          current={agent.data?.model.value}
          disabled={disabled}
          onChange={(model) => void agent.setModel(model)}
          onAdd={agent.addModel}
          onRemove={agent.removeModel}
        />
      );
      break;
    case "thinking":
      body = <ThinkingSection current={agent.data?.thinking.value} supported={agent.data?.supportedThinking ?? []} disabled={disabled} onChange={(level) => void agent.setThinking(level)} />;
      break;
    case "heartbeat":
      body = <HeartbeatSection values={values} disabled={disabled} onChange={config.setConfig} />;
      break;
    case "voice":
      body = <TtsSection values={values} disabled={disabled} onChange={config.setConfig} />;
      break;
    case "image":
      body = <ImageGenSection values={values} disabled={disabled} onChange={config.setConfig} />;
      break;
    case "channels":
      body = <ChannelsSection values={values} disabled={disabled} onChange={config.setConfig} />;
      break;
    case "memory":
      body = <MemorySection values={values} models={agent.models} disabled={disabled} onChange={config.setConfig} onClear={config.clearConfig} />;
      break;
    case "notifications":
      body = <NotificationsSection />;
      break;
    case "devices":
      body = onSignedOut ? <DevicesSection currentDevice={authDevice} onSignedOut={onSignedOut} /> : null;
      break;
  }

  return (
    <div className={detail ? "settings is-detail" : "settings"}>
      <aside className="settings-nav">
        <div className="settings-nav-title">
          <h2>settings</h2>
          <span>how they think, speak and keep</span>
          <button type="button" className="settings-close settings-nav-close" title="back to the conversation" aria-label="back to the conversation" onClick={onClose}>
            <IconX />
          </button>
        </div>
        <nav className="settings-groups" aria-label="settings sections">
          {GROUPS.map((group) => (
            <div key={group} className="settings-group">
              <span className="settings-group-label">{group}</span>
              {visible
                .filter((s) => s.group === group)
                .map(({ id, label, icon: Icon }) => (
                  <button key={id} type="button" className="settings-item" aria-current={id === current.id || undefined} onClick={() => {
                      setSection(id);
                      setDetail(true);
                    }}
                  >
                    <Icon />
                    {label}
                    {id === "channels" && <span className="settings-badge">{channelCount}</span>}
                  </button>
                ))}
            </div>
          ))}
        </nav>
      </aside>
      <section className="settings-panel" aria-labelledby="settings-panel-title">
        <div className="settings-panel-head">
          <button type="button" className="settings-back" onClick={() => setDetail(false)}>
            <IconChevronDown />
            settings
          </button>
          <div>
            <h3 id="settings-panel-title">{current.label}</h3>
            <p>{current.description}</p>
          </div>
          {(current.id === "model" || current.id === "thinking") && (
            <span className="settings-source">
              <i />
              {source === "override" ? "set for this channel" : "from the default config"}
            </span>
          )}
          <button type="button" className="settings-close" title="back to the conversation" aria-label="back to the conversation" onClick={onClose}>
            <IconX />
          </button>
        </div>
        <div className="settings-body">
          {error && (
            <p role="alert" className="settings-error">
              {error}
            </p>
          )}
          {body}
        </div>
      </section>
    </div>
  );
}
