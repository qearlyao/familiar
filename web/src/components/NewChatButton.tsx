import { useState } from "react";
import { SquarePen } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { startNewChat } from "@/lib/api";

interface NewChatButtonProps {
  channelKey: string | undefined;
  onStarted: () => void;
}

export function NewChatButton({ channelKey, onStarted }: NewChatButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const confirm = async () => {
    if (!channelKey) return;
    setBusy(true);
    setError(undefined);
    try {
      await startNewChat(channelKey);
      setOpen(false);
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="new chat"
        title="new chat"
        className="size-8 text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <SquarePen className="size-4" />
      </Button>
      <AlertDialogContent className="bg-card">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-serif text-xl tracking-tight">
            start fresh?
          </AlertDialogTitle>
          <AlertDialogDescription className="font-sans text-sm">
            this clears the agent's context. you'll still see the conversation above, but they
            won't.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p className="font-serif text-xs italic text-destructive">{error}</p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void confirm();
            }}
            disabled={busy || !channelKey}
          >
            {busy ? "starting…" : "start fresh"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
