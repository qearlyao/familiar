import type { ReactNode } from "react";
import { Dialog } from "radix-ui";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { Sheet } from "./Sheet";
import { IconX } from "./organicIcons";

/** A room held open beside the talk instead of replacing it (Chat 1a): a 330px column on the
    right, the same panel raised as a sheet once the talk needs the width back. The shelf costs
    354px, so it gives up the column long before the rail does — under 1200 the header starts
    wrapping its status line. The mock draws the column layout at 1240. */
const SHEET_BELOW = "(max-width: 1199.98px)";

export function Shelf({ open, onClose, title, sub, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** the line under the title — what this shelf is, or where it stands */
  sub: string;
  children: ReactNode;
}) {
  const sheet = useMediaQuery(SHEET_BELOW);
  const heading = <b>{title}</b>;
  const panel = (
    <>
      <span className="shelf-grab" aria-hidden />
      <header className="shelf-head">
        <div>
          {sheet ? <Dialog.Title asChild>{heading}</Dialog.Title> : heading}
          <span>{sub}</span>
        </div>
        <button type="button" className="shelf-close" aria-label="close the shelf" title="close the shelf" onClick={onClose}>
          <IconX size={15} />
        </button>
      </header>
      {children}
    </>
  );

  if (sheet) {
    return (
      <Sheet open={open} onOpenChange={(next) => !next && onClose()} className="shelf">
        {panel}
      </Sheet>
    );
  }
  if (!open) return null;
  return <aside className="shelf" aria-label={title}>{panel}</aside>;
}
