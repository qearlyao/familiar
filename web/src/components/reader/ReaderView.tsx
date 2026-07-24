import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ALargeSmall, Feather, LibraryBig, TableOfContents, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchBook,
  fetchBookChapter,
  saveBookPosition,
  type BookChapter,
  type BookDetail,
  type BookSummary,
  type MarginaliaEntry,
} from "@/lib/api";
import { loadMode, saveMode, type ThemeMode } from "@/lib/theme";
import { buildTextIndex, rangeToOffsets, type TextIndex } from "./anchors";
import { usePagination } from "./usePagination";
import { useMarginalia } from "./useMarginalia";
import { MarginPanel, type PendingQuote } from "./MarginPanel";
import { NoteCard, SelectionToolbar, type SelectionAnchor } from "./SelectionToolbar";

const CHROME_IDLE_MS = 3000;
const FONT_KEY = "familiar.reader.fontsize";
/** Wait for a selection to stop changing (touch handles, keyboard) before showing the toolbar. */
const SELECTION_SETTLE_MS = 220;
/** Keep toolbar state alive briefly after native selection collapses so its tap still lands. */
const SELECTION_LINGER_MS = 300;
/** Ignore viewport clicks right after a selection dismiss so they don't turn pages. */
const DISMISS_QUIET_MS = 400;

interface SelectionState extends SelectionAnchor {
  start: number;
  end: number;
  /** Layout the anchor rects were measured in; a mismatch means they're stale. */
  layoutId: string;
}

interface NoteTarget {
  entry: MarginaliaEntry;
  at: { top: number; left: number };
  layoutId: string;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function ChromeAction({
  icon: Icon,
  iconClassName,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  iconClassName?: string;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        active
          ? "text-primary"
          : "text-muted-foreground hover:text-primary focus-visible:text-foreground",
      )}
    >
      <Icon className={cn("size-4", iconClassName)} />
    </button>
  );
}

export function ReaderView({ book, onClose }: { book: BookSummary; onClose: () => void }) {
  const [detail, setDetail] = useState<BookDetail>();
  const [chapterData, setChapterData] = useState<BookChapter>();
  const [chapterError, setChapterError] = useState<string>();
  const [fontSize, setFontSize] = useState(() => {
    const stored = Number(localStorage.getItem(FONT_KEY));
    return stored >= 14 && stored <= 22 ? stored : 17;
  });
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadMode);
  const [textIndex, setTextIndex] = useState<TextIndex>();
  const [selection, setSelection] = useState<SelectionState>();
  const [noteTarget, setNoteTarget] = useState<NoteTarget>();
  const [pendingQuote, setPendingQuote] = useState<PendingQuote>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [menu, setMenu] = useState<"toc" | "type">();
  const [chromeVisible, setChromeVisible] = useState(true);

  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const tocRef = useRef<HTMLElement>(null);
  const loadSeqRef = useRef(0);
  const pendingChapterRef = useRef(book.position?.chapter ?? 0);
  const entryRef = useRef(book.position?.offsetRatio ?? 0);
  const posRef = useRef<{ chapter: number; ratio: number } | undefined>(undefined);
  const chromeTimerRef = useRef<number | undefined>(undefined);
  const overlayOpenRef = useRef(false);
  const dismissedAtRef = useRef(0);

  const wide = useMediaQuery("(min-width: 768px)");
  const coarse = useMediaQuery("(pointer: coarse)");
  const spread = useMediaQuery("(min-width: 1280px)") && !panelOpen;
  const chapter = chapterData?.index ?? book.position?.chapter ?? 0;
  const chapterCount = detail?.chapters.length ?? book.chapterCount;

  const loadChapter = useCallback(
    async (index: number, at: number) => {
      if (index < 0) return;
      const seq = (loadSeqRef.current += 1);
      pendingChapterRef.current = index;
      entryRef.current = at;
      setChapterError(undefined);
      setChapterData(undefined);
      try {
        // ponytail: fetch on navigation; cache only if measured latency matters.
        const loaded = await fetchBookChapter(book.id, index);
        if (loadSeqRef.current === seq) {
          setChapterData(loaded);
        }
      } catch (err) {
        if (loadSeqRef.current === seq) setChapterError(err instanceof Error ? err.message : String(err));
      }
    },
    [book.id],
  );

  useEffect(() => {
    let cancelled = false;
    fetchBook(book.id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => undefined);
    const timer = window.setTimeout(
      () => void loadChapter(book.position?.chapter ?? 0, book.position?.offsetRatio ?? 0),
      0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [book.id, book.position?.chapter, book.position?.offsetRatio, loadChapter]);

  const contentKey = `${book.id}:${chapterData?.index ?? -1}:${fontSize}`;

  // Stable identity matters: a fresh {__html} object every render makes React
  // re-set innerHTML on every commit, wiping the text nodes the selection
  // engine, highlights, and the reader's own selection live in.
  const chapterHtml = useMemo(() => ({ __html: chapterData?.html ?? "" }), [chapterData?.html]);

  const pagination = usePagination({
    viewportRef,
    contentRef,
    spread,
    contentKey,
    entryRef,
    onBoundary: (dir) => {
      if (!chapterData) return;
      const next = chapterData.index + dir;
      if (next < 0 || next >= chapterCount) return;
      void loadChapter(next, dir > 0 ? 0 : 1);
    },
  });

  // Anything positioned against the text (selection toolbar, note cards) is
  // only valid for the layout it was measured in; a mismatch hides it.
  const layoutId = `${contentKey}:${spread}:${pagination.page}:${pagination.pageCount}`;
  const layoutIdRef = useRef(layoutId);
  useEffect(() => {
    layoutIdRef.current = layoutId;
    overlayOpenRef.current = menu !== undefined || noteTarget !== undefined;
  });
  const activeSelection = selection && selection.layoutId === layoutId ? selection : undefined;
  const activeNote = noteTarget && noteTarget.layoutId === layoutId ? noteTarget : undefined;

  // Keep the entry pinned to wherever the reader actually is, so any
  // re-measure (resize, panel toggle, font settle) lands on the same text.
  useEffect(() => {
    if (pagination.ready) entryRef.current = pagination.ratio;
  }, [pagination.ratio, pagination.ready]);

  useEffect(() => {
    const content = contentRef.current;
    if (!chapterData || !content) return;
    const raf = requestAnimationFrame(() => setTextIndex(buildTextIndex(content)));
    return () => cancelAnimationFrame(raf);
  }, [chapterData]);

  const marginalia = useMarginalia({ bookId: book.id, chapter, textIndex });

  // Persist position: debounced while reading, flushed on unmount.
  useEffect(() => {
    if (!pagination.ready || !chapterData) return;
    posRef.current = { chapter: chapterData.index, ratio: pagination.ratio };
    const timer = window.setTimeout(() => {
      void saveBookPosition(book.id, chapterData.index, pagination.ratio).catch(() => undefined);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [book.id, chapterData, pagination.ratio, pagination.ready]);

  useEffect(
    () => () => {
      const pos = posRef.current;
      if (pos) void saveBookPosition(book.id, pos.chapter, pos.ratio).catch(() => undefined);
    },
    [book.id],
  );

  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize));
  }, [fontSize]);

  // Chrome fades after idle; mouse movement brings it back. Menus and note
  // cards hold it open — a popover anchored to a faded header is unusable.
  const bumpChrome = useCallback(() => {
    setChromeVisible(true);
    window.clearTimeout(chromeTimerRef.current);
    chromeTimerRef.current = window.setTimeout(() => {
      if (!overlayOpenRef.current) setChromeVisible(false);
    }, CHROME_IDLE_MS);
  }, []);
  useEffect(() => {
    chromeTimerRef.current = window.setTimeout(() => {
      if (!overlayOpenRef.current) setChromeVisible(false);
    }, CHROME_IDLE_MS);
    return () => window.clearTimeout(chromeTimerRef.current);
  }, []);

  // Selection engine. Driven by document.selectionchange (not pointerup on the
  // viewport) so it catches drags released off-viewport, iOS handle
  // adjustments, and keyboard selection alike. When the native selection
  // collapses, the toolbar lingers one beat so a tap on it still lands —
  // on touch, tapping a button collapses the selection *before* click fires.
  useEffect(() => {
    let settleTimer: number | undefined;
    let lingerTimer: number | undefined;
    let pointerDown = false;

    const capture = () => {
      const sel = window.getSelection();
      const content = contentRef.current;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !content || !textIndex) return;
      const range = sel.getRangeAt(0);
      if (!content.contains(range.commonAncestorContainer)) return;
      const offsets = rangeToOffsets(textIndex, range);
      if (!offsets || !textIndex.text.slice(offsets.start, offsets.end).trim()) return;
      const rects = range.getClientRects();
      const head = rects[0] ?? range.getBoundingClientRect();
      const tail = rects.length > 0 ? rects[rects.length - 1] : head;
      setSelection({
        ...offsets,
        layoutId: layoutIdRef.current,
        head: { top: head.top, bottom: head.bottom, left: head.left, width: head.width },
        tail: { top: tail.top, bottom: tail.bottom, left: tail.left, width: tail.width },
      });
    };

    const onSelectionChange = () => {
      window.clearTimeout(settleTimer);
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        window.clearTimeout(lingerTimer);
        lingerTimer = window.setTimeout(() => {
          dismissedAtRef.current = performance.now();
          setSelection(undefined);
        }, SELECTION_LINGER_MS);
        return;
      }
      window.clearTimeout(lingerTimer);
      if (pointerDown) return; // mid-drag: pointerup schedules the capture
      settleTimer = window.setTimeout(capture, SELECTION_SETTLE_MS);
    };
    const onPointerDown = () => {
      pointerDown = true;
    };
    const onPointerUp = () => {
      pointerDown = false;
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(capture, 40);
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    return () => {
      window.clearTimeout(settleTimer);
      window.clearTimeout(lingerTimer);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);
    };
  }, [textIndex]);

  // Layout moved under the toolbar/note card: their anchors are stale.
  // Handled by the layoutId derivation above — no imperative clearing needed.

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (activeNote) return setNoteTarget(undefined);
      if (activeSelection) {
        window.getSelection()?.removeAllRanges();
        return setSelection(undefined);
      }
      if (menu) return setMenu(undefined);
      if (panelOpen) return setPanelOpen(false);
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeNote, activeSelection, menu, onClose, panelOpen]);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setMenu(undefined);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menu]);

  // Open the contents on the chapter being read.
  useEffect(() => {
    if (menu !== "toc") return;
    tocRef.current?.querySelector("[data-current]")?.scrollIntoView({ block: "center" });
  }, [menu]);

  const clearSelection = useCallback(() => {
    dismissedAtRef.current = performance.now();
    window.getSelection()?.removeAllRanges();
    setSelection(undefined);
  }, []);

  const askAboutSelection = useCallback(() => {
    if (!activeSelection || !textIndex) return;
    setPendingQuote({
      quote: textIndex.text.slice(activeSelection.start, activeSelection.end).trim(),
      chapterTitle: chapterData?.title,
    });
    setPanelOpen(true);
    clearSelection();
  }, [activeSelection, chapterData?.title, clearSelection, textIndex]);

  const markSelection = useCallback(
    async (openNote: boolean) => {
      if (!activeSelection) return;
      const at = {
        top: activeSelection.tail.bottom + 10,
        left: activeSelection.tail.left + activeSelection.tail.width / 2,
      };
      const range = { start: activeSelection.start, end: activeSelection.end };
      clearSelection();
      const created = await marginalia.add(range);
      if (created && openNote) setNoteTarget({ entry: created, at, layoutId: layoutIdRef.current });
    },
    [activeSelection, clearSelection, marginalia],
  );

  const onViewportClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (activeSelection) return clearSelection(); // dismiss tap: never turns the page
      if (!window.getSelection()?.isCollapsed) return;
      if (performance.now() - dismissedAtRef.current < DISMISS_QUIET_MS) return;
      // The highlight is the affordance: a tap on a marked passage opens it.
      const hit = marginalia.entryAt(event.clientX, event.clientY);
      if (hit) {
        return setNoteTarget({
          entry: hit.entry,
          at: { top: hit.rect.bottom + 10, left: hit.rect.left + hit.rect.width / 2 },
          layoutId: layoutIdRef.current,
        });
      }
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width;
      const edge = coarse ? 0.3 : 0.12;
      if (x < edge) return pagination.turn(-1);
      if (x > 1 - edge) return pagination.turn(1);
      if (x > 0.3 && x < 0.7) setChromeVisible((v) => !v);
    },
    [activeSelection, clearSelection, coarse, marginalia, pagination],
  );

  const percent = useMemo(() => {
    if (!detail || !chapterData) return book.percent;
    const total = detail.chapters.reduce((sum, c) => sum + c.chars, 0);
    if (total <= 0) return undefined;
    const before = detail.chapters.slice(0, chapterData.index).reduce((sum, c) => sum + c.chars, 0);
    const here = detail.chapters[chapterData.index]?.chars ?? 0;
    return ((before + here * pagination.ratio) / total) * 100;
  }, [book.percent, chapterData, detail, pagination.ratio]);

  const chromeClass = chromeVisible
    ? "opacity-100 translate-y-0"
    : "pointer-events-none opacity-0 -translate-y-1.5";

  return (
    <div
      className="fixed inset-0 z-50 flex bg-background text-foreground"
      onPointerMove={(e) => {
        if (e.pointerType === "mouse") bumpChrome();
      }}
    >
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header
          ref={headerRef}
          className={cn(
            "relative z-20 flex h-13 items-center px-3 transition-all duration-300 ease-out sm:px-6 motion-reduce:transition-none",
            chromeClass,
          )}
        >
          <ChromeAction icon={LibraryBig} label="shelf" onClick={onClose} />
          <div className="pointer-events-none absolute inset-x-36 top-1/2 min-w-0 -translate-y-1/2 text-center sm:inset-x-40">
            <p className="truncate font-serif text-sm leading-tight">{book.title}</p>
            {chapterData?.title ? (
              <p className="truncate font-serif text-[11px] italic leading-tight text-muted-foreground">
                {chapterData.title}
              </p>
            ) : null}
          </div>
          <div className="ml-auto flex items-center">
            <ChromeAction
              icon={ALargeSmall}
              iconClassName="size-5 translate-y-0.5"
              label="type"
              active={menu === "type"}
              onClick={() => setMenu((m) => (m === "type" ? undefined : "type"))}
            />
            <ChromeAction
              icon={TableOfContents}
              label="contents"
              active={menu === "toc"}
              onClick={() => setMenu((m) => (m === "toc" ? undefined : "toc"))}
            />
            <ChromeAction
              icon={Feather}
              label="margins"
              active={panelOpen}
              onClick={() => setPanelOpen((v) => !v)}
            />
          </div>

          {menu === "type" ? (
            <div className="absolute top-12 right-3 z-30 w-60 origin-top-right animate-in rounded-xl bg-popover p-4 shadow-xl duration-150 ease-out-quart fade-in-0 slide-in-from-bottom-[3px] sm:right-6 motion-reduce:animate-none">
              <div className="flex items-center justify-between">
                <span className="font-serif text-xs italic text-muted-foreground">type size</span>
                <div className="flex items-center">
                  <button
                    type="button"
                    aria-label="smaller type"
                    disabled={fontSize <= 14}
                    onClick={() => setFontSize((s) => Math.max(14, s - 1))}
                    className="flex h-7 w-9 items-center justify-center rounded-md font-serif text-[13px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35 focus-visible:text-foreground focus-visible:outline-none"
                  >
                    A
                  </button>
                  <span className="min-w-7 text-center font-serif text-xs italic text-muted-foreground">
                    {fontSize}
                  </span>
                  <button
                    type="button"
                    aria-label="larger type"
                    disabled={fontSize >= 22}
                    onClick={() => setFontSize((s) => Math.min(22, s + 1))}
                    className="flex h-7 w-9 items-center justify-center rounded-md font-serif text-[19px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35 focus-visible:text-foreground focus-visible:outline-none"
                  >
                    A
                  </button>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between">
                <span className="font-serif text-xs italic text-muted-foreground">the light</span>
                <div className="flex gap-0.5">
                  {(["light", "dark", "auto"] as ThemeMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        saveMode(mode);
                        setThemeMode(mode);
                      }}
                      className={cn(
                        "rounded-md px-2 py-1 font-serif text-xs transition-colors focus-visible:bg-accent focus-visible:outline-none",
                        themeMode === mode
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                      )}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
          {menu === "toc" && detail ? (
            <nav
              ref={tocRef}
              aria-label="contents"
              className="absolute top-12 right-3 z-30 max-h-[60vh] w-max min-w-44 max-w-80 origin-top-right animate-in overflow-y-auto rounded-xl bg-popover py-3 shadow-xl duration-150 ease-out-quart fade-in-0 slide-in-from-bottom-[3px] sm:right-6 motion-reduce:animate-none"
            >
              {detail.chapters.map((c) => {
                const isCurrent = c.index === chapter;
                return (
                  <button
                    key={c.index}
                    type="button"
                    data-current={isCurrent || undefined}
                    onClick={() => {
                      setMenu(undefined);
                      void loadChapter(c.index, 0);
                    }}
                    className={cn(
                      "block w-full truncate px-5 py-2 text-left font-serif text-sm transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none",
                      isCurrent
                        ? "text-primary"
                        : c.index < chapter
                          ? "text-muted-foreground/70"
                          : "text-popover-foreground",
                    )}
                  >
                    {c.title || `chapter ${c.index + 1}`}
                  </button>
                );
              })}
            </nav>
          ) : null}
        </header>

        <div className="relative min-h-0 flex-1">
          <div
            className={cn(
              "mx-auto h-full px-6 pb-2 sm:px-14",
              spread ? "max-w-[88rem]" : "max-w-2xl",
            )}
          >
            <div
              ref={viewportRef}
              className={cn("h-full overflow-hidden select-text", !pagination.ready && "opacity-0")}
              onClick={onViewportClick}
            >
              {chapterData ? (
                <div
                  ref={contentRef}
                  className="reader-content"
                  style={{ fontSize: `${fontSize}px` }}
                  dangerouslySetInnerHTML={chapterHtml}
                />
              ) : null}
            </div>
          </div>

          {!chapterData ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              {chapterError ? (
                <div className="pointer-events-auto max-w-sm px-6 text-center">
                  <p className="font-serif text-sm italic text-destructive">the page wouldn't turn</p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{chapterError}</p>
                  <button
                    type="button"
                    onClick={() => void loadChapter(pendingChapterRef.current, entryRef.current)}
                    className="mt-3 font-serif text-sm italic text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  >
                    try again
                  </button>
                </div>
              ) : (
                <p className="animate-in font-serif text-sm italic text-muted-foreground/70 delay-250 duration-300 ease-out fade-in-0 fill-mode-backwards motion-reduce:animate-none">
                  opening…
                </p>
              )}
            </div>
          ) : null}

        </div>

        <footer className="flex min-h-9 items-center justify-center px-6 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <p className="truncate font-serif text-[11px] italic text-muted-foreground/80">
            {marginalia.error
              ? `the margins slipped · ${marginalia.error}`
              : pagination.ready
                ? `${pagination.page + 1} of ${pagination.pageCount}${percent != null ? ` · ${Math.round(percent)}%` : ""}`
                : ""}
          </p>
        </footer>
      </div>

      {panelOpen ? (
        wide ? (
          <aside className="z-20 my-3 mr-3 w-95 shrink-0 animate-in overflow-hidden rounded-xl bg-card shadow-lg duration-150 ease-out-quart fade-in-0 slide-in-from-bottom-[3px] motion-reduce:animate-none">
            <MarginPanel
              book={book}
              pendingQuote={pendingQuote}
              onClearQuote={() => setPendingQuote(undefined)}
              onClose={() => setPanelOpen(false)}
            />
          </aside>
        ) : (
          <div className="fixed inset-0 z-30 bg-card">
            <MarginPanel
              book={book}
              pendingQuote={pendingQuote}
              onClearQuote={() => setPendingQuote(undefined)}
              onClose={() => setPanelOpen(false)}
            />
          </div>
        )
      ) : null}

      {activeSelection ? (
        <SelectionToolbar
          anchor={activeSelection}
          coarse={coarse}
          onAsk={askAboutSelection}
          onNote={() => void markSelection(true)}
          onMark={() => void markSelection(false)}
        />
      ) : null}

      {activeNote ? (
        <NoteCard
          entry={activeNote.entry}
          at={activeNote.at}
          sheet={coarse && !wide}
          onSave={(note) => void marginalia.saveNote(activeNote.entry.id, note)}
          onRemove={() => void marginalia.remove(activeNote.entry.id)}
          onClose={() => setNoteTarget(undefined)}
        />
      ) : null}
    </div>
  );
}
