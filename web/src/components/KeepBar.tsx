import { useEffect, useState } from "react";
import { keepClipping } from "@/lib/api";
import { IconKeep } from "./organicIcons";
import "./keep-bar.css";

/** Stands where the composer does while a stretch of the talk is being picked out to keep. */
export function KeepBar({ channelKey, span, count, onDone }: {
  channelKey: string | undefined;
  /** the ends picked so far, by message id: none, one, or both */
  span: string[];
  /** how many turns lie between them */
  count: number;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [state, setState] = useState<"picking" | "keeping" | "kept">("picking");
  const [error, setError] = useState<string>();

  // linger on "kept" for a breath, then hand the room back
  useEffect(() => {
    if (state !== "kept") return;
    const id = window.setTimeout(onDone, 1400);
    return () => window.clearTimeout(id);
  }, [state, onDone]);

  const keep = async () => {
    setState("keeping");
    setError(undefined);
    try {
      await keepClipping({ channelKey, from: span[0], to: span[span.length - 1], note });
      setState("kept");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("picking");
    }
  };

  const hint =
    state === "kept" ? "kept. it’s on the library shelf."
    : state === "keeping" ? "keeping…"
    : count === 0 ? "tap where it starts."
    : span.length < 2 ? "now tap where it ends — or keep just this one."
    : `${count} turns, end to end. tap again to start over.`;
  const idle = state === "picking";

  return (
    <div className="composer keep-bar">
      <div className="composer-veil" aria-hidden><i /><i /><i /><i /></div>
      <div className="composer-inner">
        <form
          className="composer-box has-text"
          onSubmit={(event) => {
            event.preventDefault();
            if (idle && count > 0) void keep();
          }}
        >
          <div className="composer-left">
            <span className="keep-bar-hint" role="status">{hint}</span>
            {count > 0 && state !== "kept" && (
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={280}
                disabled={!idle}
                placeholder="a line of your own, if you like"
                aria-label="a line of your own"
              />
            )}
          </div>
          <div className="composer-right">
            {state !== "kept" && <button type="button" className="chat-action" disabled={!idle} onClick={onDone}>never mind</button>}
            <button type="submit" className="composer-send" disabled={!idle || count === 0} aria-label="keep">
              <IconKeep /> <span className="label">keep</span>
            </button>
          </div>
        </form>
        {error && <p className="composer-error">couldn’t keep it · {error}</p>}
      </div>
    </div>
  );
}
