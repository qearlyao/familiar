import { useState, type ReactNode } from "react";
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
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif font-normal">let "{title}" go?</AlertDialogTitle>
            <AlertDialogDescription className="font-serif italic">{farewell}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onRemove}>
              let it go
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
