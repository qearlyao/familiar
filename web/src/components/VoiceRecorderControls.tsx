import { Mic, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function VoiceRecorderControls({
  disabled,
  pending = false,
  recording,
  onToggle,
  onCancel,
}: {
  disabled?: boolean;
  pending?: boolean;
  recording: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        onClick={onToggle}
        disabled={disabled || pending}
        aria-label={recording ? "stop voice recording" : "record voice message"}
        aria-pressed={recording}
        className={cn(
          "text-muted-foreground hover:text-foreground",
          recording && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
        )}
      >
        {recording ? <Square className="size-3 fill-current" strokeWidth={0} /> : <Mic className="size-4" />}
      </Button>
      {recording ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          className="h-7 px-2 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
          <span>cancel</span>
        </Button>
      ) : null}
    </div>
  );
}
