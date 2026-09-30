import { useEffect, useId, useRef, useState } from "react";
import { fetchVoices, type TtsProvider, type VoiceOption } from "@/lib/api";
import { IconChevronDown } from "../organicIcons";
import { TextInput } from "./inputs";

/** The voice, picked by name from the ones the provider's key can use; an id pasted by hand still works. */
export function VoicePicker({
  provider,
  value,
  disabled,
  onCommit,
}: {
  provider: TtsProvider;
  value: string | undefined;
  disabled: boolean;
  onCommit: (next: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // the list is asked for once, the first time the panel opens
  useEffect(() => {
    if (!open || voices || error) return;
    fetchVoices()
      .then(setVoices)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [open, voices, error]);

  const current = voices?.find((voice) => voice.id === value);
  const q = query.trim().toLowerCase();
  const shown = (voices ?? []).filter((voice) => !q || [voice.name, voice.id, voice.category ?? "", ...voice.labels].some((text) => text.toLowerCase().includes(q)));

  const pick = (id: string) => {
    panelRef.current?.hidePopover();
    if (id !== value) void onCommit(id).catch(() => undefined);
  };

  return (
    <div className="voice-picker">
      <button type="button" className="pill-input voice-picker-trigger" aria-haspopup="listbox" aria-expanded={open} disabled={disabled} popoverTarget={panelId}>
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
      {/* the browser closes it on Escape or a click outside; the contents mount only while it is open */}
      <div ref={panelRef} id={panelId} popover="auto" className="voice-picker-panel" role="dialog" aria-label="voices" onToggle={(event) => setOpen(event.newState === "open")}>
        {open && (
          <>
          {error ? (
            <p className="voice-picker-note is-error">{error}</p>
          ) : !voices ? (
            <p className="voice-picker-note">asking {provider === "cartesia" ? "cartesia" : "11labs"}…</p>
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
          </>
        )}
      </div>
    </div>
  );
}
