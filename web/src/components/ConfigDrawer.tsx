import { useState, type ReactNode } from "react";
import {
  Bot,
  Brain,
  ChevronRight,
  Database,
  HeartPulse,
  Image,
  MonitorSmartphone,
  Palette,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ModelSection } from "./config/ModelSection";
import { ThinkingSection } from "./config/ThinkingSection";
import { ThemeSection } from "./config/ThemeSection";
import { HeartbeatSection } from "./config/HeartbeatSection";
import { ImageGenSection } from "./config/ImageGenSection";
import { MemorySection } from "./config/MemorySection";
import { TtsSection } from "./config/TtsSection";
import { DevicesSection } from "./config/DevicesSection";
import { useAgentSettings } from "@/lib/useAgentSettings";
import { useConfig } from "@/lib/useConfig";
import type { WebAuthDevice } from "@/lib/api";

interface ConfigDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelKey: string | undefined;
  authMode?: string;
  authDevice?: WebAuthDevice;
  onSignedOut?: () => void;
}

interface SectionProps {
  title: string;
  description: string;
  icon: LucideIcon;
  defaultOpen?: boolean;
  children: ReactNode;
}

function Section({ title, description, icon: Icon, defaultOpen = false, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-start gap-4 rounded-md px-2 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
        <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block font-serif text-base leading-tight tracking-tight text-foreground">
            {title}
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {description}
          </span>
        </span>
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:text-foreground",
            open && "rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-2 pb-5">
          <div className="mt-4">{children}</div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function GroupLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("px-2 pt-4 pb-1 font-serif text-xs italic text-muted-foreground", className)}>
      {children}
    </p>
  );
}

export function ConfigDrawer({
  open,
  onOpenChange,
  channelKey,
  authMode,
  authDevice,
  onSignedOut,
}: ConfigDrawerProps) {
  const {
    data,
    models,
    addedModels,
    error: agentError,
    isLoading: agentLoading,
    isMutating: agentMutating,
    setModel,
    setThinking,
    addModel,
    removeModel,
  } = useAgentSettings(channelKey);

  const {
    data: configData,
    error: configError,
    isLoading: configLoading,
    isMutating: configMutating,
    setConfig,
    clearConfig,
  } = useConfig(open);

  const ready = Boolean(data) && Boolean(configData);
  const busy = agentLoading || agentMutating || configLoading || configMutating;
  const error = agentError ?? configError;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-screen bg-card shadow-2xl sm:w-md sm:max-w-md sm:rounded-l-2xl"
        side="right"
      >
        <SheetHeader className="px-6 pt-6 pb-2">
          <SheetTitle className="font-serif text-2xl leading-none tracking-tight text-foreground">
            settings
          </SheetTitle>
        </SheetHeader>
        <div className="flex flex-col overflow-y-auto px-5 pt-1 pb-8">
          <GroupLabel className="pt-1">conversation</GroupLabel>
          <Section
            title="model"
            description="which language model carries this conversation."
            icon={Bot}
            defaultOpen
          >
            <ModelSection
              models={models}
              added={addedModels}
              current={data?.model.value}
              source={data?.model.source}
              disabled={!ready || busy}
              onChange={(model) => void setModel(model)}
              onAdd={addModel}
              onRemove={removeModel}
            />
          </Section>
          <Section
            title="thinking"
            description="how long the model deliberates before answering."
            icon={Brain}
          >
            <ThinkingSection
              current={data?.thinking.value}
              supported={data?.supportedThinking ?? []}
              disabled={!ready || busy}
              onChange={(level) => void setThinking(level)}
            />
          </Section>
          <GroupLabel>companion</GroupLabel>
          <Section
            title="heartbeat"
            description="your companion's pulse when you've gone quiet."
            icon={HeartPulse}
          >
            <HeartbeatSection
              values={configData?.values}
              disabled={!ready || busy}
              onChange={setConfig}
            />
          </Section>
          <Section
            title="voice"
            description="which voice and model your companion speaks with."
            icon={Volume2}
          >
            <TtsSection
              values={configData?.values}
              disabled={!ready || busy}
              onChange={setConfig}
            />
          </Section>
          <Section
            title="image generation"
            description="which model your companion uses to paint."
            icon={Image}
          >
            <ImageGenSection
              values={configData?.values}
              disabled={!ready || busy}
              onChange={setConfig}
            />
          </Section>
          <Section
            title="memory"
            description="how older conversation is condensed and how earlier memories return."
            icon={Database}
          >
            <MemorySection
              values={configData?.values}
              models={models}
              disabled={!ready || busy}
              onChange={setConfig}
              onClear={clearConfig}
            />
          </Section>
          <GroupLabel>room</GroupLabel>
          <Section title="theme" description="light, dark, or follow your system." icon={Palette}>
            <ThemeSection />
          </Section>
          {authMode === "bearer" && onSignedOut ? (
            <Section
              title="devices"
              description="where this web room is still open."
              icon={MonitorSmartphone}
            >
              <DevicesSection currentDevice={authDevice} onSignedOut={onSignedOut} />
            </Section>
          ) : null}
          {error ? (
            <p className="mt-4 font-serif text-xs italic text-destructive">{error}</p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
