import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { focusPanel } from "@/lib/focusPanel";
import { IconDownload, IconX } from "./organicIcons";

/** The ink room shared by pictures, clips, pages and pdfs: title, download, close, and whatever
    the caller puts in the body. Focus returns to the trigger only when Escape closed it. */
export function ViewerDialog({ trigger, title, subtitle, download, extraActions, bare, closeLabel = "back to the thread", onOpenChange, onKeyDown, children }: {
  trigger: ReactNode;
  title: string;
  subtitle: ReactNode;
  download: { href: string; name: string };
  extraActions?: ReactNode;
  bare?: boolean;
  closeLabel?: string;
  onOpenChange?: (open: boolean) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const closedByKey = useRef(false);
  return (
    <Dialog.Root onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="viewer-overlay" />
        <Dialog.Content
          className="viewer chat-theme"
          data-bare={bare || undefined}
          aria-describedby={undefined}
          onOpenAutoFocus={focusPanel}
          onCloseAutoFocus={(event) => {
            if (!closedByKey.current) event.preventDefault();
            closedByKey.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") closedByKey.current = true;
            onKeyDown?.(event);
          }}
        >
          <header className="viewer-head">
            <Dialog.Close className="viewer-ghost viewer-close-top" aria-label={closeLabel}><IconX size={18} /></Dialog.Close>
            <span className="viewer-title">
              <Dialog.Title title={title}>{title}</Dialog.Title>
              <p>{subtitle}</p>
            </span>
          </header>

          <div className="viewer-actions">
            <a className="viewer-accent" href={download.href} download={download.name} title="download the original">
              <IconDownload size={16} /> download
            </a>
            {extraActions}
            <Dialog.Close className="viewer-ghost viewer-close-side" aria-label="close"><IconX size={18} /></Dialog.Close>
          </div>

          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
