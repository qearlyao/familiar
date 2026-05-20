import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
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
import { useAgentSettings } from "@/lib/useAgentSettings";

interface ConfigDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelKey: string | undefined;
}

interface SectionProps {
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

function Section({ title, description, defaultOpen = false, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 py-3 text-left">
        <ChevronRight
          className={cn(
            "size-3.5 text-muted-foreground transition-transform duration-150 group-hover:text-foreground",
            open && "rotate-90",
          )}
        />
        <h3 className="font-serif text-lg leading-tight tracking-tight text-foreground">
          {title}
        </h3>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pb-4">
          <p className="font-serif text-xs italic text-muted-foreground">{description}</p>
          <div className="mt-4">{children}</div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ConfigDrawer({ open, onOpenChange, channelKey }: ConfigDrawerProps) {
  const {
    data,
    models,
    addedModels,
    error,
    isLoading,
    isMutating,
    setModel,
    setThinking,
    addModel,
    removeModel,
  } = useAgentSettings(channelKey);

  const ready = Boolean(data);
  const busy = isLoading || isMutating;

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
        <div className="flex flex-col overflow-y-auto px-6 pt-2 pb-8">
          <Section
            title="model"
            description="which language model carries this conversation."
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
          >
            <ThinkingSection
              current={data?.thinking.value}
              supported={data?.supportedThinking ?? []}
              disabled={!ready || busy}
              onChange={(level) => void setThinking(level)}
            />
          </Section>
          <Section title="theme" description="light, dark, or follow your system.">
            <ThemeSection />
          </Section>
          {error ? (
            <p className="mt-4 font-serif text-xs italic text-destructive">{error}</p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
