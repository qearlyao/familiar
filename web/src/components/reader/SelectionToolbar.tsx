import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MarginaliaEntry } from "@/lib/api";

export interface SelectionAnchor {
  /** First line of the selection (viewport coordinates). */
  head: { top: number; bottom: number; left: number; width: number };
  /** Last line of the selection. */
  tail: { top: number; bottom: number; left: number; width: number };
}

const EDGE = 8;
const GAP = 10;

/**
 * Floating ask · note · mark pill. Sits above the first selected line on fine
 * pointers; below the last line on touch, clear of the native handles.
 * Measured after mount so it clamps to the real viewport, never clips.
 */
export function SelectionToolbar({
  anchor,
  coarse,
  onAsk,
  onNote,
  onMark,
}: {
  anchor: SelectionAnchor;
  coarse: boolean;
  onAsk: () => void;
  onNote: () => void;
  onMark: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Position by measuring the rendered pill, then writing styles directly:
  // clamped to the viewport, flipped below the selection when there's no
  // headroom (and always below on touch, clear of the native handles).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const below = coarse || anchor.head.top - height - GAP < EDGE;
    const base = below ? anchor.tail : anchor.head;
    const top = below
      ? Math.min(base.bottom + GAP, window.innerHeight - height - EDGE)
      : base.top - height - GAP;
    const center = base.left + base.width / 2;
    const left = Math.min(Math.max(center - width / 2, EDGE), window.innerWidth - width - EDGE);
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    el.style.transformOrigin = below ? "top center" : "bottom center";
    el.style.visibility = "visible";
  }, [anchor, coarse]);

  const actions = [
    { label: "ask", run: onAsk },
    { label: "note", run: onNote },
    { label: "mark", run: onMark },
  ];

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="passage actions"
      className="fixed z-50 flex animate-in items-stretch rounded-full bg-popover px-1 font-serif text-sm text-popover-foreground shadow-xl duration-150 ease-out-quart fade-in-0 slide-in-from-bottom-[3px] motion-reduce:animate-none"
      style={{ top: anchor.head.top, left: anchor.head.left, visibility: "hidden" }}
    >
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={action.run}
          className="touch-manipulation px-3.5 py-2 transition-colors hover:text-primary focus-visible:text-primary focus-visible:outline-none"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A margin note: floating slip near the mark on desktop, bottom sheet on phones.
 */
export function NoteCard({
  entry,
  at,
  sheet,
  onSave,
  onRemove,
  onClose,
}: {
  entry: MarginaliaEntry;
  at: { top: number; left: number };
  sheet: boolean;
  onSave: (note: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(entry.note ?? "");
  const cardRef = useRef<HTMLDivElement>(null);
  const dirty = draft.trim() !== (entry.note ?? "");

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!cardRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  const save = () => {
    if (dirty) onSave(draft.trim());
    onClose();
  };

  const body = (
    <>
      <p className="line-clamp-3 font-serif text-xs italic leading-[1.9] text-muted-foreground">
        <span className="rounded-xs bg-primary/15 box-decoration-clone px-1 py-0.5">{entry.quote}</span>
      </p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
        }}
        placeholder="what do you feel here…"
        rows={sheet ? 4 : 3}
        autoFocus={!entry.note}
        className="mt-3 w-full resize-none bg-transparent font-serif text-sm leading-relaxed placeholder:italic placeholder:text-muted-foreground/60 focus:outline-none"
      />
      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            onRemove();
            onClose();
          }}
          className="font-serif text-xs italic text-muted-foreground transition-colors hover:text-destructive focus-visible:text-destructive focus-visible:outline-none"
        >
          {entry.note ? "remove note" : "remove mark"}
        </button>
        <button
          type="button"
          disabled={!dirty}
          onClick={save}
          className="rounded-md bg-primary px-3 py-1.5 font-serif text-xs text-primary-foreground transition-[opacity,transform] active:translate-y-px disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          keep note
        </button>
      </div>
    </>
  );

  if (sheet) {
    return (
      <div
        ref={cardRef}
        className="fixed inset-x-0 bottom-0 z-50 animate-in rounded-t-2xl bg-popover p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl duration-200 ease-out-quart fade-in-0 slide-in-from-bottom-4 motion-reduce:animate-none"
      >
        {body}
      </div>
    );
  }

  const top = Math.min(at.top, window.innerHeight - 280);
  const left = Math.min(Math.max(EDGE + 4, at.left - 160), window.innerWidth - 332);
  return (
    <div
      ref={cardRef}
      className="fixed z-50 w-80 animate-in rounded-xl bg-popover p-5 shadow-xl duration-150 ease-out-quart fade-in-0 slide-in-from-bottom-[3px] motion-reduce:animate-none"
      style={{ top, left }}
    >
      {body}
    </div>
  );
}
