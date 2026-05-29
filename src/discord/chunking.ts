import type { Config } from "../config.js";

// A hard split at an arbitrary index can land between the two UTF-16 code units
// of an astral character (emoji, rare CJK), rendering as a broken � at the seam.
// Back off by one so the whole surrogate pair moves to the next chunk. Splits at
// whitespace land on a space and are unaffected.
function avoidSurrogateSplit(text: string, index: number): number {
	if (index <= 0 || index >= text.length) return index;
	const high = text.charCodeAt(index - 1);
	const low = text.charCodeAt(index);
	if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) return index - 1;
	return index;
}

function chunkDiscordSimple(text: string, limit = 2000): string[] {
	if (text.length <= limit) return [text || "(empty response)"];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= limit) {
			chunks.push(remaining);
			break;
		}
		const breakpoint = Math.max(remaining.lastIndexOf("\n", limit), remaining.lastIndexOf(" ", limit));
		const splitAt = breakpoint > 0 ? breakpoint : avoidSurrogateSplit(remaining, limit);
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).trimStart();
	}
	return chunks;
}

function splitLongBlock(block: string, limit: number): string[] {
	if (block.length <= limit) return [block];
	const pieces: string[] = [];
	let lineCurrent = "";
	for (const line of block.split("\n")) {
		const candidate = lineCurrent ? `${lineCurrent}\n${line}` : line;
		if (candidate.length <= limit) {
			lineCurrent = candidate;
			continue;
		}
		if (lineCurrent) {
			pieces.push(lineCurrent);
			lineCurrent = "";
		}
		if (line.length <= limit) {
			lineCurrent = line;
			continue;
		}
		let remaining = line;
		while (remaining.length > limit) {
			let splitAt = remaining.lastIndexOf(" ", limit);
			if (splitAt < Math.floor(limit * 0.6)) splitAt = avoidSurrogateSplit(remaining, limit);
			pieces.push(remaining.slice(0, splitAt));
			remaining = remaining.slice(splitAt).trimStart();
		}
		lineCurrent = remaining;
	}
	if (lineCurrent) pieces.push(lineCurrent);
	return pieces;
}

function chunkDiscordParagraph(text: string, limit = 2000): string[] {
	if (text.length <= limit) return [text || "(empty response)"];
	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	const pushCurrent = () => {
		if (current.trim()) chunks.push(current);
		current = "";
	};

	for (const paragraph of paragraphs) {
		if (!paragraph) continue;
		for (const part of splitLongBlock(paragraph, limit)) {
			const candidate = current ? `${current}\n\n${part}` : part;
			if (candidate.length <= limit) {
				current = candidate;
			} else {
				pushCurrent();
				current = part;
			}
		}
	}
	pushCurrent();
	return chunks.length > 0 ? chunks : [normalized.slice(0, limit)];
}

function splitPreservingCodeFences(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n");
	const segments: string[] = [];
	const fence = /```/g;
	let cursor = 0;
	let inCode = false;
	let buffer = "";

	const flushParagraphs = (slab: string) => {
		const parts = slab.split(/\n\n+/);
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (i === 0) {
				buffer += part;
			} else {
				if (buffer.trim()) segments.push(buffer);
				buffer = part;
			}
		}
	};

	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
	while ((match = fence.exec(normalized)) !== null) {
		const slab = normalized.slice(cursor, match.index);
		if (inCode) {
			buffer += slab + match[0];
			inCode = false;
		} else {
			flushParagraphs(slab);
			buffer += match[0];
			inCode = true;
		}
		cursor = match.index + match[0].length;
	}
	const tail = normalized.slice(cursor);
	if (inCode) {
		buffer += tail;
	} else {
		flushParagraphs(tail);
	}
	if (buffer.trim()) segments.push(buffer);

	return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

function chunkDiscordNewline(text: string, limit = 2000): string[] {
	const segments = splitPreservingCodeFences(text);
	if (segments.length === 0) return [];
	const chunks: string[] = [];
	for (const segment of segments) {
		if (segment.length <= limit) {
			chunks.push(segment);
			continue;
		}
		for (const part of splitLongBlock(segment, limit)) {
			if (part.trim()) chunks.push(part);
		}
	}
	return chunks;
}

export function chunkDiscord(config: Config, text: string): string[] {
	if (config.discord.chunkMode === "simple") return chunkDiscordSimple(text);
	if (config.discord.chunkMode === "newline") return chunkDiscordNewline(text);
	return chunkDiscordParagraph(text);
}
