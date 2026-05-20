import { useEffect, useMemo, useRef, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Smile } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fetchMemes, type Meme, type MemeFamily } from "@/lib/api";

interface MemePickerProps {
  onPick: (meme: Meme) => void;
}

export function MemePicker({ onPick }: MemePickerProps) {
  const [open, setOpen] = useState(false);
  const [families, setFamilies] = useState<MemeFamily[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeFamilyName, setActiveFamilyName] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const loadingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    if (families != null || loadingRef.current) return;
    loadingRef.current = true;
    fetchMemes()
      .then((data) => {
        setFamilies(data);
        if (!activeFamilyName && data[0]) setActiveFamilyName(data[0].name);
        setError(null);
      })
      .catch(() => setError("catalog unavailable"))
      .finally(() => {
        loadingRef.current = false;
      });
  }, [open, families, activeFamilyName]);

  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => searchRef.current?.focus(), 30);
      return () => window.clearTimeout(id);
    }
    setQuery("");
  }, [open]);

  const activeFamily = useMemo(() => {
    if (!families) return null;
    return families.find((f) => f.name === activeFamilyName) ?? families[0] ?? null;
  }, [families, activeFamilyName]);

  const visibleMemes = useMemo(() => {
    if (!activeFamily) return [];
    const q = query.trim().toLowerCase();
    if (!q) return activeFamily.memes;
    return activeFamily.memes.filter((m) => m.name.toLowerCase().includes(q));
  }, [activeFamily, query]);

  const handlePick = (meme: Meme) => {
    onPick(meme);
    setOpen(false);
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="memes"
          className="text-muted-foreground hover:text-foreground"
        >
          <Smile className="size-4" />
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="end"
          sideOffset={10}
          collisionPadding={16}
          className={cn(
            "z-50 w-[min(28rem,calc(100vw-2rem))] origin-(--radix-popover-content-transform-origin)",
            "rounded-md border border-border bg-card p-3 shadow-md",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          {error ? (
            <div className="px-2 py-6 text-center font-serif text-sm italic text-muted-foreground">
              {error}
            </div>
          ) : !families ? (
            <div className="px-2 py-6 text-center font-serif text-sm italic text-muted-foreground/80">
              opening the drawer…
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 px-1 pb-2 text-sm">
                {families.map((family, idx) => (
                  <span key={family.name} className="flex items-center gap-3">
                    {idx > 0 && (
                      <span className="text-muted-foreground/40">·</span>
                    )}
                    <button
                      type="button"
                      onClick={() => setActiveFamilyName(family.name)}
                      className={cn(
                        "font-serif tracking-tight transition-colors",
                        family.name === activeFamily?.name
                          ? "text-foreground"
                          : "italic text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {family.name}
                    </button>
                  </span>
                ))}
              </div>
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="search by name…"
                className={cn(
                  "mb-2 w-full rounded border border-input bg-background px-2.5 py-1.5 text-sm",
                  "placeholder:text-muted-foreground focus:outline-none",
                  "transition-[border-color,box-shadow] focus:border-ring focus:ring-3 focus:ring-ring/30",
                )}
              />
              <div className="max-h-72 overflow-y-auto">
                {visibleMemes.length === 0 ? (
                  <div className="px-2 py-6 text-center font-serif text-sm italic text-muted-foreground/80">
                    nothing in this family matches
                  </div>
                ) : (
                  <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                    {visibleMemes.map((meme) => (
                      <button
                        key={meme.url}
                        type="button"
                        onClick={() => handlePick(meme)}
                        title={meme.name}
                        className={cn(
                          "group relative aspect-square overflow-hidden rounded border border-border/60 bg-background",
                          "transition-[border-color,transform] hover:border-ring hover:-translate-y-px",
                        )}
                      >
                        <img
                          src={meme.url}
                          alt={meme.name}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                        <span
                          className={cn(
                            "pointer-events-none absolute inset-x-0 bottom-0 truncate px-1 py-0.5",
                            "bg-gradient-to-t from-background/95 via-background/70 to-transparent",
                            "text-[10px] font-medium leading-tight text-foreground",
                            "opacity-0 transition-opacity group-hover:opacity-100",
                          )}
                        >
                          {meme.name}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
