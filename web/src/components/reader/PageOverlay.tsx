import { useEffect, useState, type RefObject } from "react";
import type { MarginaliaEntry } from "@/lib/api";

export type ScaleBox = { kind: "paragraph"; blocks: HTMLElement[] } | { kind: "page" };
export interface PageDot {
  entry: MarginaliaEntry;
  kind: "note" | "thread";
  range: Range;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAGE_BLEED = { x: 20, top: 18, bottom: 10 };
const DOT = 9;

/**
 * Paint that can't live in ::highlight: the paragraph or page a selection has
 * grown to, and the quiet-mode marks beside passages that carry writing.
 * Measured against the stage, re-measured whenever the layout moves.
 */
export function PageOverlay({
  stageRef,
  viewportRef,
  layoutId,
  scaleBox,
  dots,
  dotGap,
  onDot,
}: {
  stageRef: RefObject<HTMLElement | null>;
  viewportRef: RefObject<HTMLElement | null>;
  layoutId: string;
  scaleBox?: ScaleBox;
  dots: PageDot[];
  /** Distance from the text's left edge to the mark. */
  dotGap: number;
  onDot: (entry: MarginaliaEntry) => void;
}) {
  const [boxes, setBoxes] = useState<{ scale: Box[]; dots: (Box & PageDot)[] }>({ scale: [], dots: [] });

  useEffect(() => {
    const stage = stageRef.current?.getBoundingClientRect();
    const view = viewportRef.current?.getBoundingClientRect();
    if (!stage || !view) return;
    const rel = (r: { top: number; left: number; width: number; height: number }): Box => ({
      top: r.top - stage.top,
      left: r.left - stage.left,
      width: r.width,
      height: r.height,
    });
    const onScreen = (r: DOMRect) => r.width > 0 && r.right > view.left + 4 && r.left < view.right - 4 && r.bottom > view.top && r.top < view.bottom;

    let scale: Box[] = [];
    if (scaleBox?.kind === "page") {
      scale = [rel({ top: view.top - PAGE_BLEED.top, left: view.left - PAGE_BLEED.x, width: view.width + PAGE_BLEED.x * 2, height: view.height + PAGE_BLEED.top + PAGE_BLEED.bottom })];
    } else if (scaleBox?.kind === "paragraph") {
      scale = scaleBox.blocks.flatMap((block) => Array.from(block.getClientRects()).filter(onScreen).map(rel));
    }
    const marks = dots.flatMap((dot) => {
      const line = Array.from(dot.range.getClientRects()).find(onScreen);
      return line ? [{ ...dot, ...rel({ top: line.top + line.height / 2 - DOT / 2, left: view.left - dotGap, width: DOT, height: DOT }) }] : [];
    });
    const raf = requestAnimationFrame(() => setBoxes({ scale, dots: marks }));
    return () => cancelAnimationFrame(raf);
  }, [dotGap, dots, layoutId, scaleBox, stageRef, viewportRef]);

  return (
    <>
      {boxes.scale.map((box, index) => (
        <div key={index} aria-hidden="true" className={`reader-scale-box is-${scaleBox?.kind}`} style={box} />
      ))}
      {boxes.dots.map((dot) => (
        <button
          key={dot.entry.id}
          type="button"
          className={`reader-page-dot is-${dot.kind}`}
          aria-label={dot.kind === "thread" ? "open the thread" : "open your note"}
          style={{ top: dot.top, left: dot.left }}
          onClick={() => onDot(dot.entry)}
        />
      ))}
    </>
  );
}
