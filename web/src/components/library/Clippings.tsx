import type { FocusEvent, KeyboardEvent } from "react";
import { Dialog } from "radix-ui";
import type { Clipping } from "@/lib/api";
import { clippingQuote, said } from "@/lib/clippingQuote";
import type { Message } from "../../types";
import { MessageRows } from "../MessageList";
import { IconArrow } from "../organicIcons";
import { noteAge } from "../reader/marginText";
import { ViewerDialog } from "../ViewerDialog";
import { ShelfItem } from "./ShelfItem";
import "./clippings.css";

const FAREWELL = "it leaves the shelf. the talk it came from stays where it was.";
const PEEK_TURNS = 3;

function moment(clipping: Clipping): string {
  const ts = clipping.messages[0]?.ts ?? clipping.createdAt;
  return new Date(ts).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" }).toLowerCase();
}

/** The way it ended, small: the last few things said, each on its own side as the talk had them. */
function ClippingCover({ turns }: { turns: Message[] }) {
  return (
    <span aria-hidden className="library-clipping-cover library-shelf-cover">
      {turns.map((turn) => (
        <span key={turn.id} data-role={turn.role}>{said(turn).replace(/[*_`#>]/g, "") || "…"}</span>
      ))}
    </span>
  );
}

/** a field that saves when you leave it or press enter, and only if it changed */
function saving(current: string | undefined, save: (value: string) => void) {
  return {
    defaultValue: current ?? "",
    onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.target.value.trim() !== (current ?? "")) save(event.target.value);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.currentTarget.blur();
    },
  };
}

/** One kept moment: opens as the talk looked, can be named and given a line of your own there,
    and rides back into the draft as a quote. One they kept says so, and its line stays theirs. */
export function ClippingTile({ clipping, personaName, onBring, onEdit, onRemove }: {
  clipping: Clipping;
  personaName: string;
  onBring: (name: string, quote: string) => void;
  onEdit: (edit: { title?: string; note?: string }) => void;
  onRemove: () => void;
}) {
  const turns = clipping.messages.filter((message) => message.role !== "system" && !message.call);
  const title = clipping.title || clipping.note || said(turns[0] ?? clipping.messages[0]).split("\n")[0] || "a moment";
  const count = `${clipping.messages.length} ${clipping.messages.length === 1 ? "turn" : "turns"}`;
  const theirs = clipping.keptBy === "them";
  const kept = theirs ? `kept by ${personaName}` : "kept";
  return (
    <ShelfItem title={title} farewell={FAREWELL} onRemove={onRemove}>
      {/* the span keeps the context menu and the viewer from fighting over one trigger */}
      <span className="contents">
        <ViewerDialog
          trigger={
            <button type="button" className="library-shelf-tile" aria-label={`open ${title}`}>
              <ClippingCover turns={turns.slice(-PEEK_TURNS)} />
              <span className="library-shelf-copy">
                <strong>{title}</strong>
                <span>{count} · {kept} {noteAge(clipping.createdAt)}</span>
              </span>
            </button>
          }
          title={title}
          titleField={
            <input
              className="library-clipping-title"
              maxLength={120}
              placeholder="name this moment…"
              aria-label="name this moment"
              {...saving(clipping.title, (value) => onEdit({ title: value }))}
            />
          }
          subtitle={`${moment(clipping)} · ${count}${theirs ? ` · ${kept}` : ""}`}
          closeLabel="back to the library"
          extraActions={
            <Dialog.Close asChild>
              <button type="button" className="viewer-accent" onClick={() => onBring(title, clippingQuote(clipping.messages))}>
                <IconArrow size={16} /> bring to the talk
              </button>
            </Dialog.Close>
          }
        >
          <div className="viewer-body">
            <div className="viewer-stage">
              <div className="viewer-frame">
                <div className="library-clipping-paper">
                  {/* chat-room carries the talk's own styles; it clips, so the paper around it does the scrolling */}
                  <div className="chat-room">
                    <MessageRows messages={clipping.messages} personaName={personaName} dated />
                    {/* a moment they kept carries their line, as they wrote it; yours is always open to write in */}
                    {theirs ? (
                      clipping.note && <p className="library-clipping-note">{clipping.note} <span>— {personaName}</span></p>
                    ) : (
                      <textarea
                        className="library-clipping-note"
                        rows={2}
                        maxLength={280}
                        placeholder="add a line of your own…"
                        aria-label="a line of your own"
                        {...saving(clipping.note, (value) => onEdit({ note: value }))}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </ViewerDialog>
      </span>
    </ShelfItem>
  );
}
