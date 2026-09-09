import { useEffect, useId, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { focusPanel } from "@/lib/focusPanel";
import { fetchFile, saveFile } from "@/lib/api";
import { parseContactNickname } from "../../../src/conversation/contact-nickname";
import "./contact-card.css";

export function ContactCard() {
  const [open, setOpen] = useState(false);
  const [nickname, setNickname] = useState("");
  // null until the first load lands: the avatar stays blank rather than guessing.
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const value = parseContactNickname((await fetchFile("contact")).content, "");
      setNickname(value);
      setSaved(value);
    } catch (cause) {
      console.error("[contact] could not load nickname", cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  // once for the avatar initial; every open reloads so the field is current
  useEffect(() => {
    fetchFile("contact")
      .then((file) => setSaved(parseContactNickname(file.content, "")))
      .catch((cause) => console.error("[contact] could not load avatar nickname", cause));
  }, []);

  function changeOpen(next: boolean) {
    if (saving) return;
    setOpen(next);
    if (next) void load();
  }

  const ready = saved !== null && !loading && !saving;
  useEffect(() => { if (open && ready) input.current?.focus(); }, [open, ready]);

  async function save() {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      const value = nickname.trim();
      const file = await saveFile("contact", value ? `${value}\n` : "");
      setSaved(parseContactNickname(file.content, ""));
      setOpen(false);
    } catch (cause) {
      console.error("[contact] could not save nickname", cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger className="room-rail-you" aria-label="edit your nickname" title={saved === null ? "edit your nickname" : saved || "you"}>
        <span aria-hidden="true">{saved === null ? "" : Array.from(saved || "you")[0].toUpperCase()}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="chat-theme contact-card"
          side="right" align="end" sideOffset={16} alignOffset={38}
          collisionPadding={16}
          aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
          onOpenAutoFocus={focusPanel}
        >
          <form onSubmit={(event) => { event.preventDefault(); void save(); }} aria-busy={loading || saving}>
            <h2 id={`${id}-title`}>what I call you</h2>
            <p id={`${id}-description`} className="contact-description">a little name, just between us.</p>
            <label htmlFor={`${id}-nickname`}>nickname</label>
            <input ref={input} id={`${id}-nickname`} value={nickname} onChange={(event) => setNickname(event.target.value)}
              disabled={!ready} autoComplete="off" aria-describedby={`${id}-hint`}
              placeholder={loading ? "loading…" : "you"} />
            <p id={`${id}-hint`} className="contact-hint">Leave blank to use “you”.</p>
            {error && <p className="contact-error" role="alert">{error}</p>}
            <div className="contact-actions">
              {saved === null && !loading && <button type="button" onClick={() => void load()}>Retry</button>}
              <button type="button" disabled={saving} onClick={() => changeOpen(false)}>Cancel</button>
              <button className="contact-save" type="submit" disabled={!ready}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
