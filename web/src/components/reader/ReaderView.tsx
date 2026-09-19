import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/lib/useMediaQuery";
import {
  BOOK_PAGE_CHARS,
  fetchBook,
  fetchBookChapter,
  saveBookPosition,
  type BookChapter,
  type BookDetail,
  type BookSummary,
  type MarginScale,
  type MarginaliaEntry,
} from "@/lib/api";
import { buildTextIndex, findQuote, rangeToOffsets, type TextIndex } from "./anchors";
import { TURN_MS, usePagination } from "./usePagination";
import { useMarginalia, type MarginRange } from "./useMarginalia";
import { paragraphsOf, visiblePage } from "./visiblePage";
import { NoteCard, SelectionToolbar, type SelectionAnchor } from "./SelectionToolbar";
import { BookNotesDrawer } from "./BookNotesDrawer";
import { ReaderMargin } from "./ReaderMargin";
import { PageOverlay, type PageDot, type ScaleBox } from "./PageOverlay";
import { ReaderTypePopover } from "./ReaderTypePopover";
import { entryKind, noteTally } from "./marginText";
import { CircleGauge } from "lucide-react";
import { BackIcon, MarginIcon, NotesIcon } from "./readerIcons";

const CHROME_IDLE_MS = 3000;
const FONT_KEY = "familiar.reader.fontsize";
const PAPER_KEY = "familiar.reader.paper";
/** A steady reading pace, in characters a minute, for "min left in this chapter". */
const CHARS_PER_MINUTE = 1200;
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
  /** The chapter content it was made in, for growing it to whole paragraphs. */
  content: HTMLElement;
}

interface NoteTarget {
  entry: MarginaliaEntry;
  at: { top: number; left: number };
  layoutId: string;
}

export function ReaderView({ book, onClose, personaName }: { book: BookSummary; onClose: () => void; personaName: string }) {
  const [detail, setDetail] = useState<BookDetail>();
  const [chapterData, setChapterData] = useState<BookChapter>();
  const [chapterError, setChapterError] = useState<string>();
  const [seekError, setSeekError] = useState<string>();
  const [fontSize, setFontSize] = useState(() => {
    const stored = Number(localStorage.getItem(FONT_KEY));
    return stored >= 14 && stored <= 22 ? stored : 17;
  });
  const [paper, setPaper] = useState(() => {
    const stored = localStorage.getItem(PAPER_KEY);
    return stored === "clay" || stored === "sage" ? stored : "sand";
  });
  const [textIndex, setTextIndex] = useState<TextIndex>();
  const [selection, setSelection] = useState<SelectionState>();
  // The chosen scale belongs to one selection; a new selection starts back at words.
  const [scaleChoice, setScaleChoice] = useState<{ key: string; scale: MarginScale }>();
  const [noteTarget, setNoteTarget] = useState<NoteTarget>();
  const [visible, setVisible] = useState<{ start: number; end: number; layoutId: string }>();
  const [marginVisible, setMarginVisible] = useState(true);
  const [marginSheetOpen, setMarginSheetOpen] = useState(false);
  const [allNotesOpen, setAllNotesOpen] = useState(false);
  const [menu, setMenu] = useState<"toc" | "type">();
  const [chromeVisible, setChromeVisible] = useState(true);

  const layoutRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const tocRef = useRef<HTMLElement>(null);
  const loadSeqRef = useRef(0);
  const pendingChapterRef = useRef(book.position?.chapter ?? 0);
  const entryRef = useRef(book.position?.offsetRatio ?? 0);
  const posRef = useRef<{ chapter: number; ratio: number } | undefined>(undefined);
  const dismissedAtRef = useRef(0);
  const pendingJumpRef = useRef<MarginaliaEntry | undefined>(undefined);

  const wide = useMediaQuery("(min-width: 768px)");
  const coarse = useMediaQuery("(pointer: coarse)");
  // Reading without the margin is full-screen reading: two pages side by side when there's room.
  const spread = useMediaQuery("(min-width: 1100px)") && !marginVisible;
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
        if (loadSeqRef.current === seq) setChapterData(loaded);
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

  // Anything positioned against the text (selection toolbar, note cards, the
  // visible span) is only valid for the layout it was measured in.
  const layoutId = `${contentKey}:${spread}:${pagination.page}:${pagination.pageCount}:${marginVisible && wide}`;
  const layoutIdRef = useRef(layoutId);
  useEffect(() => {
    layoutIdRef.current = layoutId;
  });
  const activeSelection = selection && selection.layoutId === layoutId ? selection : undefined;
  const selectionKey = selection ? `${selection.start}:${selection.end}` : "";
  const scale = scaleChoice?.key === selectionKey ? scaleChoice.scale : "word";
  const activeNote = noteTarget && noteTarget.layoutId === layoutId ? noteTarget : undefined;
  const onScreen = visible && visible.layoutId === layoutId ? visible : undefined;

  // Keep the entry pinned to wherever the reader actually is, so any
  // re-measure (resize, margin toggle, font settle) lands on the same text.
  useEffect(() => {
    if (pagination.ready) entryRef.current = pagination.ratio;
  }, [pagination.ratio, pagination.ready]);

  useEffect(() => {
    const content = contentRef.current;
    if (!chapterData || !content) return;
    const raf = requestAnimationFrame(() => setTextIndex(buildTextIndex(content)));
    return () => cancelAnimationFrame(raf);
  }, [chapterData]);

  // What's on screen, as chapter text offsets: drives the margin and the page scale.
  useEffect(() => {
    if (!pagination.ready || !textIndex) return;
    // Measure once the page turn has settled; mid-slide the rects belong to neither page.
    const timer = window.setTimeout(() => {
      const viewport = viewportRef.current;
      const content = contentRef.current;
      const found = viewport && content ? visiblePage(textIndex, viewport, content) : undefined;
      setVisible(found ? { start: found.start, end: found.end, layoutId } : undefined);
    }, TURN_MS);
    return () => window.clearTimeout(timer);
  }, [layoutId, pagination.ready, textIndex]);

  const marginalia = useMarginalia({ bookId: book.id, chapter, textIndex });
  const chapterEntries = useMemo(
    () => marginalia.entries.filter((entry) => entry.chapter === chapter),
    [chapter, marginalia.entries],
  );
  const tally = noteTally(marginalia.entries);

  const jumpTo = useCallback((entry: MarginaliaEntry, index: TextIndex) => {
    pendingJumpRef.current = undefined;
    const found = findQuote(index, entry.quote, entry.prefix, entry.suffix);
    if (!found) return setSeekError("that note's place on the page could not be found");
    pagination.seek(found.start / Math.max(1, index.text.length));
  }, [pagination]);

  const seekEntry = useCallback((entry: MarginaliaEntry) => {
    setAllNotesOpen(false);
    setMarginSheetOpen(false);
    setSeekError(undefined);
    pendingJumpRef.current = entry;
    if (entry.chapter !== chapter) return void loadChapter(entry.chapter, 0);
    if (textIndex) jumpTo(entry, textIndex);
  }, [chapter, jumpTo, loadChapter, textIndex]);

  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (pending && textIndex && chapterData?.index === pending.chapter) jumpTo(pending, textIndex);
  }, [chapterData?.index, jumpTo, textIndex]);

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

  useEffect(() => localStorage.setItem(FONT_KEY, String(fontSize)), [fontSize]);
  useEffect(() => localStorage.setItem(PAPER_KEY, paper), [paper]);

  // A center click toggles the chrome; pointer movement never reveals it.
  // Pause idle hiding while the margin or a reading control is open, then give
  // the reader a fresh timeout when it closes or the chrome is revealed again.
  const chromeHeldOpen = menu !== undefined || activeNote !== undefined || activeSelection !== undefined
    || allNotesOpen || marginSheetOpen || (wide && marginVisible);
  useEffect(() => {
    if (!chromeVisible || chromeHeldOpen) return;
    const timer = window.setTimeout(() => setChromeVisible(false), CHROME_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [chromeVisible, chromeHeldOpen]);

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
        content,
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (allNotesOpen) return setAllNotesOpen(false);
      if (activeNote) return setNoteTarget(undefined);
      if (activeSelection) {
        window.getSelection()?.removeAllRanges();
        return setSelection(undefined);
      }
      if (menu) return setMenu(undefined);
      if (marginSheetOpen) return setMarginSheetOpen(false);
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeNote, activeSelection, allNotesOpen, marginSheetOpen, menu, onClose]);

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

  // The selection as grown to its chosen scale: the words, their paragraphs, or the page.
  const scaled = useMemo((): (MarginRange & { box?: ScaleBox }) | undefined => {
    if (!activeSelection) return undefined;
    const words = { start: activeSelection.start, end: activeSelection.end, scale };
    if (scale === "page") return onScreen ? { start: onScreen.start, end: onScreen.end, scale, box: { kind: "page" } } : words;
    if (scale === "paragraph" && textIndex) {
      const found = paragraphsOf(textIndex, activeSelection.content, activeSelection.start, activeSelection.end);
      if (found) return { start: found.start, end: found.end, scale, box: { kind: "paragraph", blocks: found.blocks } };
    }
    return words;
  }, [activeSelection, onScreen, scale, textIndex]);

  // Grown to a paragraph, the toolbar sits under the whole paragraph, not the words.
  const toolbarAnchor = useMemo((): SelectionAnchor | undefined => {
    if (!activeSelection || scaled?.box?.kind !== "paragraph") return undefined;
    const last = scaled.box.blocks.at(-1)?.getBoundingClientRect();
    return last ? { ...activeSelection, tail: { top: last.top, bottom: last.bottom + 8, left: last.left, width: last.width } } : undefined;
  }, [activeSelection, scaled]);

  const revealMargin = useCallback(() => {
    if (wide) setMarginVisible(true);
    else setMarginSheetOpen(true);
  }, [wide]);

  const discussSelection = useCallback(async () => {
    if (!scaled) return;
    clearSelection();
    revealMargin();
    await marginalia.discuss(scaled);
  }, [clearSelection, marginalia, revealMargin, scaled]);

  const noteSelection = useCallback(async () => {
    if (!scaled || !activeSelection) return;
    const at = {
      top: activeSelection.tail.bottom + 10,
      left: activeSelection.tail.left + activeSelection.tail.width / 2,
    };
    clearSelection();
    const created = await marginalia.add(scaled);
    if (created) setNoteTarget({ entry: created, at, layoutId: layoutIdRef.current });
  }, [activeSelection, clearSelection, marginalia, scaled]);

  const highlightSelection = useCallback(async () => {
    if (!scaled) return;
    clearSelection();
    await marginalia.add(scaled);
  }, [clearSelection, marginalia, scaled]);

  const openEntry = useCallback(
    (entry: MarginaliaEntry, rect?: DOMRect) => {
      if (entryKind(entry) === "thread" || !rect) {
        revealMargin();
        if (wide) setChromeVisible(true);
        return;
      }
      setNoteTarget({
        entry,
        at: { top: rect.bottom + 10, left: rect.left + rect.width / 2 },
        layoutId: layoutIdRef.current,
      });
    },
    [revealMargin, wide],
  );

  const onViewportClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (activeSelection) return clearSelection(); // dismiss tap: never turns the page
      if (!window.getSelection()?.isCollapsed) return;
      if (performance.now() - dismissedAtRef.current < DISMISS_QUIET_MS) return;
      // The highlight is the affordance: a tap on a marked passage opens it.
      const hit = marginalia.entryAt(event.clientX, event.clientY);
      if (hit) return openEntry(hit.entry, hit.rect);
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width;
      const edge = coarse ? 0.3 : 0.12;
      if (x < edge) return pagination.turn(-1);
      if (x > 1 - edge) return pagination.turn(1);
      if (x > 0.3 && x < 0.7) setChromeVisible((v) => !v);
    },
    [activeSelection, clearSelection, coarse, marginalia, openEntry, pagination],
  );

  const progress = useMemo(() => {
    if (!detail || !chapterData) return { percent: book.percent ?? 0 };
    const total = detail.chapters.reduce((sum, c) => sum + c.chars, 0);
    const before = detail.chapters.slice(0, chapterData.index).reduce((sum, c) => sum + c.chars, 0);
    const here = detail.chapters[chapterData.index]?.chars ?? 0;
    const read = before + here * pagination.ratio;
    return {
      percent: total > 0 ? (read / total) * 100 : 0,
      page: Math.floor(read / BOOK_PAGE_CHARS) + 1,
      pageCount: Math.max(1, Math.ceil(total / BOOK_PAGE_CHARS)),
      minutesLeft: Math.round((here * (1 - pagination.ratio)) / CHARS_PER_MINUTE),
    };
  }, [book.percent, chapterData, detail, pagination.ratio]);
  const pageLabel = progress.page ? `p. ${Math.min(progress.page, progress.pageCount)} of ${progress.pageCount}` : "opening…";

  const margin = (
    <ReaderMargin
      entries={chapterEntries}
      visible={onScreen}
      personaName={personaName}
      onSeek={seekEntry}
      onReply={marginalia.reply}
    />
  );
  const showMargin = wide && marginVisible;
  // Marks in the edge stand in for the margin whenever it isn't showing.
  const { ranges } = marginalia;
  const dots = useMemo((): PageDot[] => {
    if (showMargin) return [];
    if (!onScreen) return [];
    return chapterEntries.flatMap((entry) => {
      const kind = entryKind(entry);
      const range = ranges.get(entry.id);
      if (kind === "highlight" || !range || entry.offset < onScreen.start || entry.offset >= onScreen.end) return [];
      return [{ entry, kind, range }];
    });
  }, [chapterEntries, onScreen, ranges, showMargin]);

  const toggleMenu = (name: "toc" | "type") => setMenu((m) => (m === name ? undefined : name));
  const chromeClass = chromeVisible ? "" : "is-hidden";
  const contents = detail ? (
    <nav ref={tocRef} aria-label="contents" className="reader-popover reader-toc">
      {detail.toc.map((c) => {
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
            className={cn(isCurrent && "is-current", c.index < chapter && "is-read")}
          >
            {c.title || `chapter ${c.index + 1}`}
          </button>
        );
      })}
    </nav>
  ) : null;

  return (
    <div
      className="reader-shell fixed inset-0 z-50 flex"
      data-paper={paper}
    >
      <div className="reader-surface">
        <header ref={headerRef} className={cn("reader-header", chromeClass)}>
          <button type="button" className="reader-icon-button reader-back" aria-label="back to the library" title="back to the library" onClick={onClose}>
            <BackIcon />
          </button>
          <button
            type="button"
            className="reader-book-title"
            aria-label="contents"
            aria-expanded={menu === "toc"}
            onClick={() => toggleMenu("toc")}
          >
            <p>{book.title}</p>
            <span>
              {wide
                ? `${book.author ? `${book.author} · ` : ""}${chapterData?.title || `chapter ${chapter + 1}`}`
                : pageLabel}
            </span>
          </button>
          <div className="reader-header-actions">
            {wide ? (
              <div className="reader-page-anchor">
              <button
                type="button"
                className="reader-page-position"
                title="contents"
                aria-expanded={menu === "toc"}
                onClick={() => toggleMenu("toc")}
              >
                <CircleGauge aria-hidden="true" />
                {pageLabel}
              </button>
              {menu === "toc" ? contents : null}
              </div>
            ) : null}
            <div className="reader-control-group">
              <button
                type="button"
                className={cn("reader-icon-button reader-type-toggle", menu === "type" && "is-open")}
                title="type size"
                aria-expanded={menu === "type"}
                onClick={() => toggleMenu("type")}
              >
                Aa
              </button>
              {wide ? (
                <button
                  type="button"
                  className={cn("reader-icon-button", marginVisible && "is-active")}
                  title={marginVisible ? "hide the margin" : "show the margin"}
                  aria-pressed={marginVisible}
                  onClick={() => {
                    setMarginVisible((v) => !v);
                    setChromeVisible(true);
                  }}
                >
                  <MarginIcon />
                </button>
              ) : null}
              {menu === "type" ? (
                <ReaderTypePopover fontSize={fontSize} paper={paper} onFontSize={setFontSize} onPaper={setPaper} />
              ) : null}
            </div>
            <button type="button" className="reader-all-notes" title="every note in this book" onClick={() => setAllNotesOpen(true)}>
              <NotesIcon />
              <span>{tally.total}{wide ? ` ${tally.total === 1 ? "note" : "notes"}` : ""}</span>
            </button>
          </div>

          {menu === "toc" && !wide ? contents : null}
        </header>

        <main className="reader-stage">
          <div ref={layoutRef} className={cn("reader-reading-layout", showMargin && "has-margin", spread && "is-spread")}>
            <div className="reader-page-frame">
              <div
                ref={viewportRef}
                className={cn("reader-viewport select-text", !pagination.ready && "opacity-0")}
                onClick={onViewportClick}
              >
                {chapterData ? (
                  <>
                    {chapterData.css ? <style>{chapterData.css}</style> : null}
                    <div
                      ref={contentRef}
                      className="reader-content"
                      data-scale={activeSelection ? scale : undefined}
                      style={{ fontSize: `${fontSize}px` }}
                      dangerouslySetInnerHTML={chapterHtml}
                    />
                  </>
                ) : null}
              </div>
            </div>
            {showMargin ? margin : null}
            <PageOverlay
              stageRef={layoutRef}
              viewportRef={viewportRef}
              layoutId={layoutId}
              scaleBox={scaled?.box}
              dots={dots}
              dotGap={wide ? 46 : 13}
              onDot={openEntry}
            />
          </div>

          {!chapterData ? (
            <div className="reader-loading">
              {chapterError ? (
                <div>
                  <p>the page wouldn't turn</p>
                  <code>{chapterError}</code>
                  <button type="button" onClick={() => void loadChapter(pendingChapterRef.current, entryRef.current)}>
                    try again
                  </button>
                </div>
              ) : (
                <p>opening…</p>
              )}
            </div>
          ) : null}
        </main>

        <footer className={cn("reader-footer", chromeClass)}>
          <div className="reader-progress-track">
            <i style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
            <b style={{ left: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
          </div>
          <p>
            {seekError
              ? seekError
              : marginalia.error
                ? `the margins slipped · ${marginalia.error}`
                : !progress.page
                  ? ""
                  : wide
                    ? progress.minutesLeft >= 1
                      ? `${progress.minutesLeft} min left in this chapter`
                      : "almost the end of this chapter"
                    : `p. ${progress.page}`}
          </p>
        </footer>
        {!chromeVisible && progress.page ? <span className="reader-quiet-page">{progress.page}</span> : null}
      </div>

      {marginSheetOpen && !wide ? (
        <div className="reader-margin-sheet" role="dialog" aria-label="the margin">
          <button type="button" className="reader-margin-sheet-dim" aria-label="back to the page" onClick={() => setMarginSheetOpen(false)} />
          <div>{margin}</div>
        </div>
      ) : null}

      {allNotesOpen ? (
        <BookNotesDrawer
          book={book}
          chapters={detail?.chapters ?? []}
          entries={marginalia.entries}
          personaName={personaName}
          compact={!wide}
          onClose={() => setAllNotesOpen(false)}
          onEntry={seekEntry}
        />
      ) : null}

      {activeSelection ? (
        <SelectionToolbar
          anchor={toolbarAnchor ?? activeSelection}
          coarse={coarse}
          compact={!wide}
          scale={scale}
          onScale={(next) => setScaleChoice({ key: selectionKey, scale: next })}
          onDiscuss={() => void discussSelection()}
          onNote={() => void noteSelection()}
          onHighlight={() => void highlightSelection()}
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
