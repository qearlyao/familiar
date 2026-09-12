import { useEffect, useMemo, useRef, useState } from "react";
import { fetchMemes, type Meme, type MemeFamily } from "@/lib/api";

export function StickerPanel({ onPick, onClose }: { onPick: (meme: Meme) => void; onClose: () => void }) {
  const [families, setFamilies] = useState<MemeFamily[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeFamilyName, setActiveFamilyName] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchMemes()
      .then((data) => {
        setFamilies(data);
        setActiveFamilyName((current) => current ?? data[0]?.name ?? null);
      })
      .catch(() => setError("catalog unavailable"));
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (panelRef.current?.contains(target)) return;
      if (target?.closest('[aria-label="stickers"]')) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);

  const activeFamily = useMemo(() => families?.find((f) => f.name === activeFamilyName) ?? families?.[0] ?? null, [families, activeFamilyName]);
  const visible = useMemo(() => {
    if (!activeFamily) return [];
    const q = query.trim().toLowerCase();
    return q ? activeFamily.memes.filter((m) => m.name.toLowerCase().includes(q)) : activeFamily.memes;
  }, [activeFamily, query]);

  return (
    <div ref={panelRef} className="composer-panel sticker-panel" role="dialog" aria-label="stickers">
      {error ? (
        <p className="sticker-empty">{error}</p>
      ) : !families ? (
        <p className="sticker-empty">opening the drawer…</p>
      ) : (
        <>
          <div className="sticker-filters">
            {families.map((family) => (
              <button key={family.name} type="button" className="sticker-filter" aria-pressed={family.name === activeFamily?.name} onClick={() => setActiveFamilyName(family.name)}>
                {family.name}
              </button>
            ))}
            <input type="text" className="sticker-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search by name…" autoFocus />
          </div>
          {visible.length === 0 ? (
            <p className="sticker-empty">nothing in this family matches</p>
          ) : (
            <div className="sticker-scroll">
              <div className="sticker-grid">
                {visible.map((meme) => (
                  <button key={meme.url} type="button" className="sticker-tile" title={meme.name} onClick={() => onPick(meme)}>
                    <img src={meme.url} alt={meme.name} loading="lazy" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
