import { useEffect, useRef, type KeyboardEvent } from "react";
import { X } from "lucide-react";

import type { DraftBlock, DraftSelection } from "@/lib/composerDraft";
import {
  hasDraftBlocksContent,
  insertMemeDraftBlock,
  removeDraftBlock,
} from "@/lib/composerDraft";
import { MemePicker } from "./MemePicker";

type DraftBlocksUpdater = (update: (blocks: DraftBlock[]) => DraftBlock[]) => void;

function textSelection(
  blocks: DraftBlock[],
  refs: Map<number, HTMLTextAreaElement>,
  activeIndex: number,
): DraftSelection | undefined {
  const blockIndex =
    blocks[activeIndex]?.type === "text"
      ? activeIndex
      : blocks.findIndex((block) => block.type === "text");
  const block = blocks[blockIndex];
  if (blockIndex === -1 || !block || block.type !== "text") return undefined;
  const el = refs.get(blockIndex);
  const cursor = block.value.length;
  return {
    blockIndex,
    start: el?.selectionStart ?? cursor,
    end: el?.selectionEnd ?? cursor,
  };
}

export function DraftEditor({
  blocks,
  personaName,
  onUpdateBlocks,
  onPasteFiles,
  onSubmit,
  onCommandKeyDown,
}: {
  blocks: DraftBlock[];
  personaName: string;
  onUpdateBlocks: DraftBlocksUpdater;
  onPasteFiles: (files: File[]) => void;
  onSubmit: () => void;
  onCommandKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}) {
  const textRefs = useRef(new Map<number, HTMLTextAreaElement>());
  const activeTextIndexRef = useRef(0);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const emptyVisibleDraft = !hasDraftBlocksContent(blocks);

  useEffect(() => {
    for (const el of textRefs.current.values()) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }

    const focusIndex = pendingFocusIndexRef.current;
    if (focusIndex === null) return;
    pendingFocusIndexRef.current = null;
    const el = textRefs.current.get(focusIndex);
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, 0);
  }, [blocks]);

  const insertMeme = (meme: { name: string; url: string }) => {
    const selection = textSelection(blocks, textRefs.current, activeTextIndexRef.current);
    onUpdateBlocks((prevBlocks) => {
      const inserted = insertMemeDraftBlock(prevBlocks, selection, meme);
      pendingFocusIndexRef.current = inserted.focusIndex;
      activeTextIndexRef.current = inserted.focusIndex;
      return inserted.blocks;
    });
  };

  const removeMeme = (index: number) => {
    onUpdateBlocks((prevBlocks) => {
      const removed = removeDraftBlock(prevBlocks, index);
      pendingFocusIndexRef.current = removed.focusIndex;
      activeTextIndexRef.current = removed.focusIndex;
      return removed.blocks;
    });
  };

  return (
    <>
      <MemePicker onPick={insertMeme} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {blocks.map((block, index) =>
          block.type === "meme" ? (
            <div
              key={`${block.url}-${index}`}
              className="inline-flex max-w-[16rem] items-center gap-2 self-start rounded border border-border/70 bg-background/70 p-1 pr-1.5"
            >
              <img
                src={block.url}
                alt={block.name}
                loading="lazy"
                className="size-12 rounded-sm object-cover"
              />
              <span className="min-w-0 flex-1 truncate font-serif text-xs italic text-muted-foreground">
                {block.name}
              </span>
              <button
                type="button"
                onClick={() => removeMeme(index)}
                className="rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
                aria-label={`remove ${block.name}`}
              >
                <X className="size-3" />
              </button>
            </div>
          ) : (
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
                onUpdateBlocks((prevBlocks) => {
                  const current = prevBlocks[index];
                  if (!current || current.type !== "text") return prevBlocks;
                  const nextBlocks = [...prevBlocks];
                  nextBlocks[index] = { type: "text", value: nextValue };
                  return nextBlocks;
                });
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (files.length > 0) onPasteFiles(files);
              }}
              onKeyDown={(e) => {
                if (onCommandKeyDown?.(e)) return;
                const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  if (isMobile) {
                    // Mobile: Enter always inserts newline, user must tap Send button
                    return;
                  } else {
                    // Desktop: Enter sends (unless Shift held)
                    if (!e.shiftKey) {
                      e.preventDefault();
                      onSubmit();
                    }
                  }
                }
              }}
              placeholder={emptyVisibleDraft ? `write to ${personaName}…` : undefined}
              rows={1}
              autoFocus={index === 0}
              className="min-h-8 w-full resize-none bg-transparent leading-8 text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          ),
        )}
      </div>
    </>
  );
}
