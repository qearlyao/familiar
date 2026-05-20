import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ModelSection } from "./config/ModelSection";
import { ThinkingSection } from "./config/ThinkingSection";
import { ThemeSection } from "./config/ThemeSection";
import { useAgentSettings } from "@/lib/useAgentSettings";

interface ConfigDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelKey: string | undefined;
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
        <div className="flex flex-col gap-9 overflow-y-auto px-6 pt-2 pb-8">
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
          <ThinkingSection
            current={data?.thinking.value}
            supported={data?.supportedThinking ?? []}
            disabled={!ready || busy}
            onChange={(level) => void setThinking(level)}
          />
          <ThemeSection />
          {error ? (
            <p className="font-serif text-xs italic text-destructive">{error}</p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
