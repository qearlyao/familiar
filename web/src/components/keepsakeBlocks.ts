/** Which parts of a keepsake you haven't read yet.
 *
 *  Not a diff — a fingerprint per block. What you last looked at is kept as a set of those
 *  fingerprints, so a block that isn't in the set is new to you, whether it was added, edited
 *  or rewritten. A block that only moved keeps its fingerprint and stays read, which is right.
 *
 *  The unit is deliberately fine: one paragraph, one heading, one list item, one fenced block.
 *  A whole bullet list as one unit would light up twelve lines when the agent appended one. */

export interface KeepsakeBlock {
	/** 1-based source line the block starts on — the same number react-markdown reports */
	line: number;
	fingerprint: string;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** djb2, base36. Collisions here cost one missed highlight, so cheap beats cryptographic. */
export function fingerprint(text: string): string {
	let hash = 5381;
	for (let index = 0; index < text.length; index += 1) {
		hash = (hash * 33) ^ text.charCodeAt(index);
	}
	return (hash >>> 0).toString(36);
}

export function keepsakeBlocks(markdown: string): KeepsakeBlock[] {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const blocks: KeepsakeBlock[] = [];
	let index = 0;

	while (index < lines.length) {
		const start = lines[index];
		if (start.trim() === "") {
			index += 1;
			continue;
		}
		const from = index;
		index += 1;

		if (FENCE.test(start)) {
			// a fence runs to its closing marker, or to the end of the file if it was never closed
			const marker = FENCE.exec(start)?.[1] ?? "```";
			while (index < lines.length && !lines[index].trimStart().startsWith(marker)) index += 1;
			if (index < lines.length) index += 1;
		} else if (!HEADING.test(start)) {
			// a paragraph or a list item runs on...
			// ...until a blank line, or anything that opens a block of its own
			while (index < lines.length && lines[index].trim() !== "") {
				const next = lines[index];
				if (HEADING.test(next) || LIST_ITEM.test(next) || FENCE.test(next)) break;
				index += 1;
			}
		}

		blocks.push({ line: from + 1, fingerprint: fingerprint(lines.slice(from, index).join("\n").trim()) });
	}

	return blocks;
}

/** the lines that start a block you haven't seen. An unknown file counts as fully read —
    nothing is marked until there's a record of what you'd already looked at. */
export function unreadLines(markdown: string, seen: readonly string[] | undefined): Set<number> {
	if (!seen) return new Set();
	const read = new Set(seen);
	const lines = new Set<number>();
	for (const block of keepsakeBlocks(markdown)) {
		if (!read.has(block.fingerprint)) lines.add(block.line);
	}
	return lines;
}
