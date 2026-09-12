import { useEffect, useRef, type KeyboardEvent } from "react";

import type { DraftBlock, DraftSelection } from "@/lib/composerDraft";
import { hasDraftBlocksContent, insertMemeDraftBlock, removeDraftBlock } from "@/lib/composerDraft";
import { StickerPanel } from "./MemePicker";
import { IconX } from "./organicIcons";

type DraftBlocksUpdater = (update: (blocks: DraftBlock[]) => DraftBlock[]) => void;

function textSelection(blocks: DraftBlock[], refs: Map<number, HTMLTextAreaElement>, activeIndex: number): DraftSelection | undefined {
  const blockIndex = blocks[activeIndex]?.type === "text" ? activeIndex : blocks.findIndex((block) => block.type === "text");
  const block = blocks[blockIndex];
  if (blockIndex === -1 || !block || block.type !== "text") return undefined;
  const el = refs.get(blockIndex);
  const cursor = block.value.length;
  return { blockIndex, start: el?.selectionStart ?? cursor, end: el?.selectionEnd ?? cursor };
}

export function DraftEditor({
  blocks,
  attachments,
  onRemoveAttachment,
  onUpdateBlocks,
  onPasteFiles,
  onSubmit,
  onCommandKeyDown,
  stickersOpen,
  onStickersOpenChange,
}: {
  blocks: DraftBlock[];
  attachments: File[];
  onRemoveAttachment: (index: number) => void;
  onUpdateBlocks: DraftBlocksUpdater;
  onPasteFiles: (files: File[]) => void;
  onSubmit: () => void;
  onCommandKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  stickersOpen: boolean;
  onStickersOpenChange: (open: boolean) => void;
}) {
  const textRefs = useRef(new Map<number, HTMLTextAreaElement>());
  const activeTextIndexRef = useRef(0);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const emptyVisibleDraft = !hasDraftBlocksContent(blocks);

  useEffect(() => {
    const fitText = () => {
      for (const el of textRefs.current.values()) {
        el.style.height = "auto";
        // CSS owns the scaled maximum; remeasure when wrapping or mobile size changes.
        el.style.height = `${el.scrollHeight}px`;
      }
    };
    fitText();
    window.addEventListener("resize", fitText);
    const focusIndex = pendingFocusIndexRef.current;
    if (focusIndex !== null) {
      pendingFocusIndexRef.current = null;
      const el = textRefs.current.get(focusIndex);
      if (el) {
        el.focus();
        el.setSelectionRange(0, 0);
      }
    }
    return () => window.removeEventListener("resize", fitText);
  }, [blocks]);

  const insertMeme = (meme: { name: string; url: string }) => {
    const selection = textSelection(blocks, textRefs.current, activeTextIndexRef.current);
    onUpdateBlocks((prev) => {
      const inserted = insertMemeDraftBlock(prev, selection, meme);
      pendingFocusIndexRef.current = inserted.focusIndex;
      activeTextIndexRef.current = inserted.focusIndex;
      return inserted.blocks;
    });
    onStickersOpenChange(false);
  };

  const removeMeme = (index: number) => {
    onUpdateBlocks((prev) => {
      const removed = removeDraftBlock(prev, index);
      pendingFocusIndexRef.current = removed.focusIndex;
      activeTextIndexRef.current = removed.focusIndex;
      return removed.blocks;
    });
  };

  const memeChips = blocks.flatMap((block, index) => (block.type === "meme" ? [{ block, index }] : []));

  return (
    <div className="composer-left">
      {stickersOpen && <StickerPanel onPick={insertMeme} onClose={() => onStickersOpenChange(false)} />}
      {(attachments.length > 0 || memeChips.length > 0) && (
        <div className="composer-chips">
          {memeChips.map(({ block, index }) => (
            <button key={`${block.url}-${index}`} type="button" className="composer-chip" aria-label={`remove ${block.name}`} onClick={() => removeMeme(index)}>
              <img src={block.url} alt="" loading="lazy" />
              <span>{block.name}</span>
              <IconX />
            </button>
          ))}
          {attachments.map((file, index) => (
            <button key={`${file.name}-${index}`} type="button" className="composer-chip" aria-label={`remove attachment ${file.name}`} onClick={() => onRemoveAttachment(index)}>
              <span>{file.name}</span>
              <IconX />
            </button>
          ))}
        </div>
      )}
      {blocks.map((block, index) =>
        block.type === "meme" ? null : (
          <textarea
            key={`text-${index}`}
            ref={(node) => {
              if (node) textRefs.current.set(index, node);
              else textRefs.current.delete(index);
            }}
            value={block.value}
            onFocus={() => {
              activeTextIndexRef.current = index;
            }}
            onSelect={() => {
              activeTextIndexRef.current = index;
            }}
            onChange={(e) => {
              const nextValue = e.target.value;
              onUpdateBlocks((prev) => {
                const current = prev[index];
                if (!current || current.type !== "text") return prev;
                const next = [...prev];
                next[index] = { type: "text", value: nextValue };
                return next;
              });
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length > 0) onPasteFiles(files);
            }}
            onKeyDown={(e) => {
              if (onCommandKeyDown?.(e)) return;
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              if (window.matchMedia("(pointer: coarse)").matches) return;
              if (!e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
            aria-label="message"
            placeholder={emptyVisibleDraft ? "say something…" : undefined}
            rows={1}
            autoFocus={index === 0}
          />
        ),
      )}
    </div>
  );
}
