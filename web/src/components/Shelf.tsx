import type { ReactNode } from "react";
import { Dialog } from "radix-ui";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { Sheet } from "./Sheet";
import { IconX } from "./organicIcons";

/** A column beside the talk on desktop and landscape tablets, narrower on tablets.
    Other tablets get a floating drawer; phones get a bottom sheet. Keep this query
    in step with the shelf-slot rules in chat.css so portaled panels never reserve a column. */
const INLINE_SHELF = "(min-width: 1200px), (min-width: 1024px) and (orientation: landscape)";

export function Shelf({ open, onClose, title, sub, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** the line under the title — what this shelf is, or where it stands */
  sub: string;
  children: ReactNode;
}) {
  const sheet = !useMediaQuery(INLINE_SHELF);
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
  // both shelves stay mounted in the slot so swapping one for the other is a cross-fade,
  // not a blink; `inert` keeps the one underneath out of reach of a tab or a screen reader.
  return (
    <aside className="shelf" aria-label={title} data-shown={open ? "" : undefined} inert={!open}>
      {panel}
    </aside>
  );
}
