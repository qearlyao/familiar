import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { ModelSection } from "./config/ModelSection";
import { ThinkingSection } from "./config/ThinkingSection";
import { PersonaSection } from "./config/PersonaSection";
import { ThemeSection } from "./config/ThemeSection";
import { useAgentSettings } from "@/lib/useAgentSettings";

interface ConfigDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelKey: string | undefined;
}

export function ConfigDrawer({ open, onOpenChange, channelKey }: ConfigDrawerProps) {
  const { data, models, error, isLoading, isMutating, setModel, setThinking } =
    useAgentSettings(channelKey);

  const ready = Boolean(data);
  const busy = isLoading || isMutating;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-screen bg-card sm:max-w-md sm:w-md"
        side="right"
      >
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="font-serif text-2xl leading-none tracking-tight text-foreground">
            settings
          </SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-6 overflow-y-auto px-5 py-5">
          <ModelSection
            models={models}
            current={data?.model.value}
            source={data?.model.source}
            disabled={!ready || busy}
            onChange={(model) => void setModel(model)}
          />
          <Separator />
          <ThinkingSection
            current={data?.thinking.value}
            supported={data?.supportedThinking ?? []}
            disabled={!ready || busy}
            onChange={(level) => void setThinking(level)}
          />
          <Separator />
          <PersonaSection name={data?.persona.name} />
          <Separator />
          <ThemeSection />
          {error ? (
            <p className="font-serif text-xs italic text-destructive">{error}</p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
