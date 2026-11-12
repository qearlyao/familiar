import { useState, type ReactNode } from "react";
import { AlertDialog } from "radix-ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/** Anything on the shelf: right-click (or long-press) offers to take it off, after asking once. */
export function ShelfItem({ title, farewell, onRemove, children }: {
  title: string;
  farewell: string;
  onRemove: () => void;
  children: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            remove from shelf
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {/* the same panel the other pop-ups are: sand card over the dimmed room, a sheet on a phone */}
      <AlertDialog.Root open={confirming} onOpenChange={setConfirming}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="sheet-dim" />
          <AlertDialog.Content className="chat-theme shelf-ask">
            <AlertDialog.Title>let “{title}” go?</AlertDialog.Title>
            <AlertDialog.Description>{farewell}</AlertDialog.Description>
            <div className="threads-ask">
              <AlertDialog.Action className="threads-new" onClick={onRemove}>let it go</AlertDialog.Action>
              <AlertDialog.Cancel className="threads-nevermind">keep it</AlertDialog.Cancel>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}
