import { useState } from "react";
import type { Message } from "../types";
import { IconChevronDown, IconChevronUp, IconHangUp } from "./organicIcons";
import "./call-entry.css";

type Call = NonNullable<Message["call"]>;

const OPENED_LINES = 4;

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60));
  const ss = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

function Head({ title, meta, open, onToggle }: { title: string; meta: string; open: boolean; onToggle: () => void }) {
  return (
    <div className="call-entry-head">
      <IconHangUp size={15} />
      <b>{title}</b>
      <span className="call-entry-meta">{meta}</span>
      {open ? (
        <button type="button" className="call-entry-fold" title="fold it away" aria-expanded onClick={onToggle}>
          <IconChevronUp size={14} />
        </button>
      ) : (
        <button type="button" className="call-entry-read" aria-expanded={false} onClick={onToggle}>
          read it <IconChevronDown size={13} />
        </button>
      )}
    </div>
  );
}

/** A call in the thread: kept ones span the column in sand, folded to one line; a discarded one is a grey mark. */
export function CallEntry({ call, ts, personaName }: { call: Call; ts: number; personaName: string }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const toggle = () => setOpen((value) => !value);

  if (call.kept === false) {
    return (
      <div className="call-entry is-discarded">
        <IconHangUp size={14} />
        <span>a call, {clock(call.durationMs)} · nothing kept</span>
      </div>
    );
  }

  if (call.kept === "summary") {
    const ended = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    return (
      <section className="call-entry">
        <Head title={`you called ${personaName}`} meta={`${clock(call.durationMs)} · ended ${ended}`} open={open} onToggle={toggle} />
        {open && (
          <>
            <p className="call-entry-summary">{call.summary}</p>
            <span className="call-entry-note">kept as a summary · the recording wasn't saved</span>
          </>
        )}
      </section>
    );
  }

  const shown = all ? call.lines : call.lines.slice(0, OPENED_LINES);
  const more = call.lines.length - shown.length;
  return (
    <section className="call-entry">
      <Head
        title={`a call with ${personaName}`}
        meta={`${clock(call.durationMs)} · ${call.lines.length} ${call.lines.length === 1 ? "line" : "lines"}`}
        open={open}
        onToggle={toggle}
      />
      {open && (
        <>
          <div className={more ? "call-entry-lines has-more" : "call-entry-lines"}>
            {shown.map((line, index) => (
              <div key={index} className="call-entry-line" data-who={line.who}>
                <span>{clock(line.at).padStart(5, "0")}</span>
                <p>{line.text}</p>
              </div>
            ))}
          </div>
          {more > 0 && (
            <button type="button" className="call-entry-read call-entry-more" onClick={() => setAll(true)}>
              <IconChevronDown size={13} /> {more} more {more === 1 ? "line" : "lines"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
