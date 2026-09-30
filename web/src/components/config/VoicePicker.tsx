import { useEffect, useMemo, useRef, useState } from "react";
import { fetchVoices, type VoiceOption } from "@/lib/api";
import { IconChevronDown } from "../organicIcons";
import { TextInput } from "./inputs";

/** The ElevenLabs voice, picked by name from the voices the key can use; an id pasted by hand still works. */
export function VoicePicker({ value, disabled, onCommit }: { value: string | undefined; disabled: boolean; onCommit: (next: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // the list is asked for once, the first time the panel opens
  useEffect(() => {
    if (!open || voices || error) return;
    fetchVoices()
      .then(setVoices)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [open, voices, error]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const current = voices?.find((voice) => voice.id === value);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!voices || !q) return voices ?? [];
    return voices.filter((voice) => [voice.name, voice.id, voice.category ?? "", ...voice.labels].some((text) => text.toLowerCase().includes(q)));
  }, [voices, query]);

  const pick = (id: string) => {
    setOpen(false);
    if (id !== value) void onCommit(id).catch(() => undefined);
  };

  return (
    <div ref={rootRef} className="voice-picker">
      <button type="button" className="pill-input voice-picker-trigger" aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen((was) => !was)}>
        {value ? (
          <span className="voice-picker-current">
            {current && <b>{current.name}</b>}
            <span>{value}</span>
          </span>
        ) : (
          <span className="voice-picker-empty">not set</span>
        )}
        <IconChevronDown />
      </button>
      {open && (
        <div className="voice-picker-panel" role="dialog" aria-label="voices">
          {error ? (
            <p className="voice-picker-note is-error">{error}</p>
          ) : !voices ? (
            <p className="voice-picker-note">asking elevenlabs…</p>
          ) : (
            <>
              <input
                type="text"
                className="pill-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`search ${voices.length} voices…`}
                spellCheck={false}
                autoComplete="off"
                autoFocus
                aria-label="search voices"
              />
              <div className="voice-picker-list" role="listbox" aria-label="voice">
                {shown.map((voice) => (
                  <button key={voice.id} type="button" role="option" className="voice-pill" aria-selected={voice.id === value} onClick={() => pick(voice.id)}>
                    <b>{voice.name}</b>
                    {(voice.category || voice.labels.length > 0) && <small>{[voice.category, ...voice.labels].filter(Boolean).join(" · ")}</small>}
                  </button>
                ))}
                {shown.length === 0 && <p className="voice-picker-note">no voice matches.</p>}
              </div>
            </>
          )}
          <div className="voice-picker-paste">
            <span>or paste an id</span>
            <TextInput value={value} placeholder="voice id" allowEmpty disabled={disabled} onCommit={onCommit} />
          </div>
        </div>
      )}
    </div>
  );
}
