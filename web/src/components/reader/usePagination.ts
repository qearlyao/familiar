import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const COLUMN_GAP = 56;
const WHEEL_THRESHOLD = 60;
const WHEEL_QUIET_MS = 160;
const WHEEL_RESTART_THRESHOLD = 24;
const WHEEL_RESTART_RATIO = 1.8;
const SWIPE_THRESHOLD_PX = 48;
const TURN_MS = 240;

/**
 * True e-reader pagination: chapter HTML flows into CSS columns inside a
 * fixed-height viewport; a "page" is one viewport-width translation. Wheel,
 * trackpad swipe, arrow keys, and touch swipes all map to single page turns.
 */
export function usePagination({
  viewportRef,
  contentRef,
  spread,
  contentKey,
  entryRef,
  onBoundary,
}: {
  viewportRef: React.RefObject<HTMLElement | null>;
  contentRef: React.RefObject<HTMLElement | null>;
  spread: boolean;
  /** Changes whenever the flowed content or its typography changes. */
  contentKey: string;
  /** Where to land after (re)layout; caller-owned so re-measures land on the same text. */
  entryRef: React.RefObject<number>;
  /** Called when turning past either end of the chapter. */
  onBoundary: (dir: 1 | -1) => void;
}) {
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const layoutKey = `${contentKey}:${spread}`;
  // Ready means "measured for the layout currently on screen" — deriving it
  // from the key makes it flip false the instant content or typography moves.
  const [readyFor, setReadyFor] = useState<string>();
  const ready = readyFor === layoutKey;

  const advanceRef = useRef(0);
  const pageRef = useRef(0);
  const pageCountRef = useRef(1);
  const layoutKeyRef = useRef(layoutKey);
  const onBoundaryRef = useRef(onBoundary);

  useLayoutEffect(() => {
    layoutKeyRef.current = layoutKey;
    onBoundaryRef.current = onBoundary;
  });

  const applyTransform = useCallback(
    (nextPage: number, animate: boolean) => {
      const content = contentRef.current;
      if (!content) return;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      content.style.transition = animate && !reduceMotion ? `transform ${TURN_MS}ms cubic-bezier(0.25, 1, 0.5, 1)` : "none";
      content.style.transform = `translate3d(${-nextPage * advanceRef.current}px, 0, 0)`;
    },
    [contentRef],
  );

  const setPageBoth = useCallback((next: number) => {
    pageRef.current = next;
    setPage(next);
  }, []);

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const viewW = viewport.clientWidth;
    const viewH = viewport.clientHeight;
    if (viewW <= 0 || viewH <= 0) return;

    const columnWidth = spread ? (viewW - COLUMN_GAP) / 2 : viewW;
    const advance = viewW + COLUMN_GAP;
    advanceRef.current = advance;

    content.style.width = `${viewW}px`;
    content.style.height = `${viewH}px`;
    content.style.columnWidth = `${columnWidth}px`;
    content.style.columnGap = `${COLUMN_GAP}px`;
    content.style.columnFill = "auto";

    // scrollWidth spans every generated column; each page advances one viewport+gap.
    const count = Math.max(1, Math.round((content.scrollWidth + COLUMN_GAP) / advance));
    pageCountRef.current = count;
    setPageCount(count);

    const target = Math.min(count - 1, Math.max(0, Math.round(entryRef.current * count)));
    setPageBoth(target);
    applyTransform(target, false);
    setReadyFor(layoutKeyRef.current);
  }, [applyTransform, contentRef, entryRef, setPageBoth, spread, viewportRef]);

  const turn = useCallback(
    (dir: 1 | -1) => {
      const next = pageRef.current + dir;
      if (next < 0 || next >= pageCountRef.current) {
        onBoundaryRef.current(dir);
        return;
      }
      setPageBoth(next);
      applyTransform(next, true);
    },
    [applyTransform, setPageBoth],
  );

  // Measure on layout changes via the observer's initial delivery (fires on
  // observe, after layout, before paint), then again on resizes, image loads,
  // and web-font settle — all of which change column flow.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const observer = new ResizeObserver(() => measure());
    observer.observe(viewport);

    const images = Array.from(content.querySelectorAll("img")).filter((img) => !img.complete);
    const onSettle = () => measure();
    for (const img of images) {
      img.addEventListener("load", onSettle, { once: true });
      img.addEventListener("error", onSettle, { once: true });
    }
    document.fonts?.ready.then(onSettle).catch(() => undefined);

    return () => {
      observer.disconnect();
      for (const img of images) {
        img.removeEventListener("load", onSettle);
        img.removeEventListener("error", onSettle);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, measure]);

  // Input: wheel (mouse + trackpad, both axes), keys, touch swipe.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let acc = 0;
    let lockedUntilQuiet = false;
    let lastEventAt = 0;
    let lastDelta = 0;
    let tailDecayed = false;
    let tailFloor = Number.POSITIVE_INFINITY;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const delta = event.deltaMode === 1 ? raw * 16 : raw;
      const now = performance.now();
      const sinceLast = now - lastEventAt;
      lastEventAt = now;

      if (lockedUntilQuiet) {
        const magnitude = Math.abs(delta);
        const previousMagnitude = Math.abs(lastDelta);
        if (magnitude < previousMagnitude) {
          tailDecayed = true;
          tailFloor = Math.min(tailFloor, magnitude);
        }
        const opposes = Math.sign(delta) !== Math.sign(lastDelta) && magnitude > WHEEL_RESTART_THRESHOLD;
        const fresh = sinceLast > WHEEL_QUIET_MS;
        const restarted =
          tailDecayed && magnitude >= WHEEL_RESTART_THRESHOLD && magnitude >= tailFloor * WHEEL_RESTART_RATIO;
        if (!fresh && !opposes && !restarted) {
          lastDelta = delta;
          return;
        }
        lockedUntilQuiet = false;
        tailDecayed = false;
        tailFloor = Number.POSITIVE_INFINITY;
        acc = 0;
      }

      acc = sinceLast > WHEEL_QUIET_MS ? delta : acc + delta;
      lastDelta = delta;
      if (Math.abs(acc) >= WHEEL_THRESHOLD) {
        turn(acc > 0 ? 1 : -1);
        acc = 0;
        lockedUntilQuiet = true;
        tailDecayed = false;
        tailFloor = Math.abs(delta);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      if (event.key === "ArrowRight" || event.key === "PageDown" || (event.key === " " && !event.shiftKey)) {
        event.preventDefault();
        turn(1);
      } else if (event.key === "ArrowLeft" || event.key === "PageUp" || (event.key === " " && event.shiftKey)) {
        event.preventDefault();
        turn(-1);
      }
    };

    let touchStartX = 0;
    let touchStartY = 0;
    const onTouchStart = (event: TouchEvent) => {
      touchStartX = event.touches[0].clientX;
      touchStartY = event.touches[0].clientY;
    };
    const onTouchEnd = (event: TouchEvent) => {
      const dx = event.changedTouches[0].clientX - touchStartX;
      const dy = event.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) < Math.abs(dy)) return;
      if (!window.getSelection()?.isCollapsed) return;
      turn(dx < 0 ? 1 : -1);
    };

    viewport.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    viewport.addEventListener("touchstart", onTouchStart, { passive: true });
    viewport.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      viewport.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchend", onTouchEnd);
    };
  }, [turn, viewportRef]);

  return {
    page,
    pageCount,
    ready,
    ratio: pageCount <= 1 ? 0 : page / pageCount,
    turn,
  };
}
