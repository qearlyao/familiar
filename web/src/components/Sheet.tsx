import { Dialog } from "radix-ui";
import type { ReactNode } from "react";
import { focusPanel } from "@/lib/focusPanel";
import { cn } from "@/lib/utils";

/** A panel over a dimmed room, with a dialog's overlay, focus trap and exit run.
    Look lives on .is-sheet in chat.css: bottom sheets, or a right drawer for tablet shelves.
    Each caller decides at what width it leaves the layout (useMediaQuery). */
export function Sheet({ open, onOpenChange, className, trigger, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the panel's own class — .quick-settings, .threads, .diary-shelf */
  className: string;
  /** a Dialog.Trigger, for panels opened from their own button */
  trigger?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger}
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-dim" />
        <Dialog.Content className={cn("chat-theme is-sheet", className)} aria-describedby={undefined} onOpenAutoFocus={focusPanel}>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
