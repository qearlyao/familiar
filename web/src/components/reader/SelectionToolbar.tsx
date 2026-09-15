import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Highlighter } from "lucide-react";
import type { MarginScale, MarginaliaEntry } from "@/lib/api";
import { DiscussIcon, MoreIcon, NoteIcon } from "./readerIcons";

export interface SelectionAnchor {
  /** First line of the selection (viewport coordinates). */
  head: { top: number; bottom: number; left: number; width: number };
  /** Last line of the selection. */
  tail: { top: number; bottom: number; left: number; width: number };
}

const EDGE = 8;
const GAP = 10;
const SCALES: MarginScale[] = ["word", "paragraph", "page"];

/**
 * Floating discuss · note pill with the selection's scale — the words you
 * picked, their paragraph, or the whole page. Sits above the first selected
 * line on fine pointers; below the last line on touch, clear of the native
 * handles. Measured after mount so it clamps to the real viewport, never clips.
 */
export function SelectionToolbar({
  anchor,
  coarse,
  compact,
  scale,
  onScale,
  onDiscuss,
  onNote,
  onHighlight,
}: {
  anchor: SelectionAnchor;
  coarse: boolean;
  /** Phone width: scale chips fold behind a "more" button. */
  compact: boolean;
  scale: MarginScale;
  onScale: (scale: MarginScale) => void;
  onDiscuss: () => void;
  onNote: () => void;
  onHighlight: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scalesOpen, setScalesOpen] = useState(false);
  const showScales = !compact || scalesOpen;

  // Position by measuring the rendered pill, then writing styles directly:
  // clamped to the viewport, under the selection (flipped above only when
  // there's no room below).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    // Below the passage, as on the page mockups; above only when it would fall off the screen.
    const below = coarse || anchor.tail.bottom + GAP + height <= window.innerHeight - EDGE || anchor.head.top - height - GAP < EDGE;
    const base = below ? anchor.tail : anchor.head;
    const top = below
      ? Math.min(base.bottom + GAP, window.innerHeight - height - EDGE)
      : base.top - height - GAP;
    const center = base.left + base.width / 2;
    const left = Math.min(Math.max(center - width / 2, EDGE), window.innerWidth - width - EDGE);
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    el.style.visibility = "visible";
  }, [anchor, coarse, showScales]);

  // Keep the native selection alive: a pointerdown on the pill would collapse it.
  const hold = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="passage actions"
      className="reader-selection-toolbar fixed z-50"
      style={{ top: anchor.head.top, left: anchor.head.left, visibility: "hidden" }}
    >
      <button type="button" className="is-primary" onMouseDown={hold} onClick={onDiscuss}>
        <DiscussIcon />
        discuss
      </button>
      <button type="button" onMouseDown={hold} onClick={onNote}>
        <NoteIcon />
        {compact ? "note" : "add note"}
      </button>
      <button type="button" onMouseDown={hold} onClick={onHighlight}>
        <Highlighter />
        highlight
      </button>
      {compact ? (
        <button
          type="button"
          className="reader-selection-more"
          aria-label="selection size"
          aria-expanded={scalesOpen}
          onMouseDown={hold}
          onClick={() => setScalesOpen((open) => !open)}
        >
          <MoreIcon />
        </button>
      ) : null}
      {showScales ? (
        <>
          <span className="reader-selection-divider" aria-hidden="true" />
          <div className="reader-selection-scales" role="group" aria-label="selection size">
            {SCALES.map((item) => (
              <button key={item} type="button" aria-pressed={scale === item} onMouseDown={hold} onClick={() => onScale(item)}>
                {item}
              </button>
            ))}
          </div>
        </>
      ) : null}
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
      <span>{entry.note ? "your note" : "a highlight"} · p. {entry.page}</span>
      {entry.scale !== "page" ? <q>{entry.quote.trim()}</q> : null}
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
      />
      <div>
        <button
          type="button"
          onClick={() => {
            onRemove();
            onClose();
          }}
        >
          {entry.note ? "remove note" : "remove highlight"}
        </button>
        <button type="button" className="is-save" disabled={!dirty} onClick={save}>
          keep note
        </button>
      </div>
    </>
  );

  if (sheet) {
    return (
      <div
        ref={cardRef}
        className="reader-note-card is-sheet fixed inset-x-0 bottom-0 z-50 animate-in duration-200 ease-out-quart fade-in-0 slide-in-from-bottom-4 motion-reduce:animate-none"
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
      className="reader-note-card fixed z-50 w-80 animate-in duration-150 ease-out-quart fade-in-0 slide-in-from-bottom-[3px] motion-reduce:animate-none"
      style={{ top, left }}
    >
      {body}
    </div>
  );
}
