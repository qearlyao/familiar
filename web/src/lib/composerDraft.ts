import { legacyMemeToken } from "./legacyMemeToken.js";

export interface DraftMeme {
  name: string;
  url: string;
}

export type DraftBlock =
  | { type: "text"; value: string }
  | { type: "meme"; name: string; url: string };

export interface DraftSelection {
  blockIndex: number;
  start: number;
  end: number;
}

export interface DraftInsertion {
  blocks: DraftBlock[];
  focusIndex: number;
}

export const emptyDraftBlocks = (): DraftBlock[] => [{ type: "text", value: "" }];

function textBlock(value: string): DraftBlock {
  return { type: "text", value };
}

function meaningfulText(value: string): boolean {
  return value.trim().length > 0;
}

function joinTextBlocks(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return `${left.replace(/[ \t]+$/, "").replace(/\n+$/, "")}\n${right.replace(/^\n+/, "")}`;
}

function clampSelection(value: string, selection: DraftSelection): { start: number; end: number } {
  const start = Math.max(0, Math.min(selection.start, value.length));
  const end = Math.max(start, Math.min(selection.end, value.length));
  return { start, end };
}

function fallbackTextIndex(blocks: DraftBlock[]): number {
  let lastTextIndex = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.type === "text") {
      lastTextIndex = index;
      break;
    }
  }
  return lastTextIndex === -1 ? blocks.length : lastTextIndex;
}

export function serializeDraftBlocks(blocks: DraftBlock[]): string {
  const parts = blocks.flatMap((block) => {
    if (block.type === "meme") return [legacyMemeToken(block)];
    return meaningfulText(block.value) ? [block.value.trim()] : [];
  });
  return parts.join("\n").trim();
}

export function hasDraftBlocksContent(blocks: DraftBlock[]): boolean {
  return serializeDraftBlocks(blocks).length > 0;
}

export function composerSendDisabled({
  showAbort,
  sending,
  voiceBusy,
  hasText,
  hasAttachments,
}: {
  showAbort: boolean;
  sending: boolean;
  voiceBusy: boolean;
  hasText: boolean;
  hasAttachments: boolean;
}): boolean {
  return showAbort ? false : sending || voiceBusy || (!hasText && !hasAttachments);
}

export function insertMemeDraftBlock(
  blocks: DraftBlock[],
  selection: DraftSelection | undefined,
  meme: DraftMeme,
): DraftInsertion {
  const targetIndex =
    selection && blocks[selection.blockIndex]?.type === "text"
      ? selection.blockIndex
      : fallbackTextIndex(blocks);
  const target = blocks[targetIndex];

  if (!target || target.type !== "text") {
    return {
      blocks: [...blocks, { type: "meme", ...meme }, textBlock("")],
      focusIndex: blocks.length + 1,
    };
  }

  const { start, end } = selection ? clampSelection(target.value, selection) : { start: target.value.length, end: target.value.length };
  const before = target.value.slice(0, start);
  const after = target.value.slice(end);
  const replacement: DraftBlock[] = [
    ...(before ? [textBlock(before)] : []),
    { type: "meme", ...meme },
    textBlock(after),
  ];

  return {
    blocks: [...blocks.slice(0, targetIndex), ...replacement, ...blocks.slice(targetIndex + 1)],
    focusIndex: targetIndex + replacement.length - 1,
  };
}

export function removeDraftBlock(blocks: DraftBlock[], index: number): DraftInsertion {
  const next: DraftBlock[] = [];

  for (const [blockIndex, block] of blocks.entries()) {
    if (blockIndex === index) continue;
    const previous = next.at(-1);
    if (previous?.type === "text" && block.type === "text") {
      previous.value = joinTextBlocks(previous.value, block.value);
      continue;
    }
    next.push({ ...block });
  }

  if (next.length === 0) {
    return { blocks: emptyDraftBlocks(), focusIndex: 0 };
  }

  const afterTextIndex = next.findIndex((block, blockIndex) => blockIndex >= index && block.type === "text");
  if (afterTextIndex !== -1) return { blocks: next, focusIndex: afterTextIndex };

  let beforeTextIndex = -1;
  for (let blockIndex = next.length - 1; blockIndex >= 0; blockIndex -= 1) {
    if (next[blockIndex]?.type === "text") {
      beforeTextIndex = blockIndex;
      break;
    }
  }
  return {
    blocks: next.some((block) => block.type === "text") ? next : [...next, textBlock("")],
    focusIndex: beforeTextIndex === -1 ? next.length : beforeTextIndex,
  };
}
