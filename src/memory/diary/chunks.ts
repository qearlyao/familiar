import { basename } from "node:path";

import type { ChunkIndexer, ChunkIndexResult, MemoryChunkIndexInput } from "../index/chunk-indexer.js";

export const DIARY_CHUNK_CORPUS = "diary_chunk";

export interface DiaryChunkMetadata extends Record<string, unknown> {
	date?: string;
	heading?: string;
	valence?: number | string;
	intensity?: number | string;
}

export interface DiaryMarkdownChunk {
	text: string;
	chunkIndex: number;
	sourceId: string;
	sourceRef: string;
	metadata: DiaryChunkMetadata;
	snippet: string;
}

export interface DiaryMarkdownChunkOptions {
	sourceId?: string;
	sourceRef?: string;
	date?: string;
	metadata?: DiaryChunkMetadata;
	maxChars?: number;
}

export interface IndexDiaryMarkdownOptions extends DiaryMarkdownChunkOptions {
	indexer: ChunkIndexer;
	path: string;
	markdown: string;
	signal?: AbortSignal;
}

interface MarkdownSection {
	heading?: string;
	level?: number;
	lines: string[];
	startLine: number;
}

const DEFAULT_MAX_CHARS = 2400;
const DIARY_DATE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const FRONTMATTER_RE = /^\s*---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const METADATA_LINE_RE = /^\s*(?:<!--\s*)?@?([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*(?:-->)?\s*$/;
const SUPPORTED_METADATA_KEYS = new Set(["date", "heading", "valence", "intensity"]);

export function chunkDiaryMarkdown(markdown: string, options: DiaryMarkdownChunkOptions = {}): DiaryMarkdownChunk[] {
	const sourceId = options.sourceId ?? "diary.md";
	const sourceRef = options.sourceRef ?? sourceId;
	const { body, metadata: documentMetadata } = stripFrontmatter(markdown);
	const baseMetadata = normalizeMetadata({
		date: options.date ?? dateFromSourceId(sourceId),
		...documentMetadata,
		...options.metadata,
	});

	const sections = splitMarkdownSections(body);
	const chunks: DiaryMarkdownChunk[] = [];
	const maxChars = positiveIntegerOrDefault(options.maxChars, DEFAULT_MAX_CHARS);

	for (const section of sections) {
		const { metadata: sectionMetadata, lines } = peelMetadataLines(section.lines);
		const text = lines.join("\n").trim();
		if (!text) continue;

		const metadata = normalizeMetadata({
			...baseMetadata,
			...(section.heading ? { heading: section.heading } : {}),
			...sectionMetadata,
		});
		for (const part of splitLongText(text, maxChars)) {
			chunks.push({
				text: part,
				chunkIndex: chunks.length,
				sourceId,
				sourceRef,
				metadata,
				snippet: buildSnippet(part, metadata),
			});
		}
	}

	return chunks;
}

export function diaryChunksToIndexInputs(chunks: readonly DiaryMarkdownChunk[]): MemoryChunkIndexInput[] {
	return chunks.map((chunk) => ({
		corpus: DIARY_CHUNK_CORPUS,
		sourceId: chunk.sourceId,
		sourceRef: chunk.sourceRef,
		chunkIndex: chunk.chunkIndex,
		text: chunk.text,
		snippet: chunk.snippet,
		metadata: chunk.metadata,
	}));
}

export async function indexDiaryMarkdown(options: IndexDiaryMarkdownOptions): Promise<ChunkIndexResult> {
	const sourceId = options.sourceId ?? basename(options.path);
	const sourceRef = options.sourceRef ?? options.path;
	const chunks = chunkDiaryMarkdown(options.markdown, { ...options, sourceId, sourceRef });
	return options.indexer.replaceSource(DIARY_CHUNK_CORPUS, sourceId, diaryChunksToIndexInputs(chunks), options.signal);
}

function stripFrontmatter(markdown: string): { body: string; metadata: DiaryChunkMetadata } {
	const match = FRONTMATTER_RE.exec(markdown);
	if (!match) return { body: markdown, metadata: {} };
	return {
		body: markdown.slice(match[0].length),
		metadata: parseMetadataBlock(match[1] ?? ""),
	};
}

function splitMarkdownSections(markdown: string): MarkdownSection[] {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const sections: MarkdownSection[] = [{ lines: [], startLine: 1 }];

	for (const [lineIndex, line] of lines.entries()) {
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			const current = sections[sections.length - 1];
			if (current?.lines.every((value) => !value.trim())) current.lines = [];
			sections.push({
				heading: stripInlineMarkdown(heading[2] ?? ""),
				level: (heading[1] ?? "").length,
				lines: [line],
				startLine: lineIndex + 1,
			});
			continue;
		}
		(sections[sections.length - 1] as MarkdownSection).lines.push(line);
	}

	return sections;
}

function peelMetadataLines(lines: string[]): { metadata: DiaryChunkMetadata; lines: string[] } {
	const metadata: DiaryChunkMetadata = {};
	const body: string[] = [];
	let inMetadataLead = true;

	for (const line of lines) {
		if (isMarkdownHeading(line)) {
			continue;
		}
		const parsed = parseMetadataLine(line);
		if (inMetadataLead && parsed) {
			metadata[parsed.key] = parsed.value;
			continue;
		}
		if (line.trim()) inMetadataLead = false;
		body.push(line);
	}

	return { metadata, lines: body };
}

function parseMetadataBlock(block: string): DiaryChunkMetadata {
	const metadata: DiaryChunkMetadata = {};
	for (const line of block.split(/\r?\n/)) {
		const parsed = parseMetadataLine(line);
		if (parsed) metadata[parsed.key] = parsed.value;
	}
	return metadata;
}

function parseMetadataLine(line: string): { key: string; value: string | number } | null {
	const match = METADATA_LINE_RE.exec(line);
	if (!match) return null;
	const rawKey = (match[1] ?? "").trim();
	const key = camelMetadataKey(rawKey);
	if (!SUPPORTED_METADATA_KEYS.has(key)) return null;
	const rawValue = (match[2] ?? "").trim();
	return { key, value: parseMetadataValue(rawValue) };
}

function parseMetadataValue(value: string): string | number {
	const unquoted = value.replace(/^["']|["']$/g, "");
	if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) return Number(unquoted);
	return unquoted;
}

function normalizeMetadata(metadata: DiaryChunkMetadata): DiaryChunkMetadata {
	const out: DiaryChunkMetadata = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (value === undefined || value === null || value === "") continue;
		out[camelMetadataKey(key)] = value;
	}
	return out;
}

function camelMetadataKey(key: string): string {
	const lower = key.toLowerCase();
	return lower.replace(/[-_]([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function splitLongText(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];
	const paragraphs = text.split(/\n{2,}/);
	const chunks: string[] = [];
	let current = "";

	for (const paragraph of paragraphs) {
		const trimmed = paragraph.trim();
		if (!trimmed) continue;
		if (!current) {
			current = trimmed;
			continue;
		}
		if (`${current}\n\n${trimmed}`.length <= maxChars) {
			current = `${current}\n\n${trimmed}`;
			continue;
		}
		chunks.push(...splitOversizedParagraph(current, maxChars));
		current = trimmed;
	}
	if (current) chunks.push(...splitOversizedParagraph(current, maxChars));
	return chunks;
}

function splitOversizedParagraph(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];
	const chunks: string[] = [];
	for (let index = 0; index < text.length; ) {
		let end = Math.min(index + maxChars, text.length);
		if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
		if (end <= index) end = Math.min(index + maxChars, text.length);
		const chunk = text.slice(index, end).trim();
		if (chunk) chunks.push(chunk);
		index = end;
	}
	return chunks;
}

function isHighSurrogate(value: number): boolean {
	return value >= 0xd800 && value <= 0xdbff;
}

function buildSnippet(text: string, metadata: DiaryChunkMetadata): string {
	const prefix = [metadata.date, metadata.heading]
		.filter((value) => typeof value === "string" && value.trim())
		.join(" ");
	const body = text.replace(/\s+/g, " ").trim().slice(0, 220);
	return prefix ? `${prefix}: ${body}` : body;
}

function dateFromSourceId(sourceId: string): string | undefined {
	const match = DIARY_DATE_RE.exec(basename(sourceId));
	return match?.[1];
}

function stripInlineMarkdown(value: string): string {
	return value
		.replace(/^\s*#+\s*/, "")
		.replace(/[*_`~[\]()]/g, "")
		.trim();
}

function isMarkdownHeading(line: string): boolean {
	return /^#{1,6}\s+/.test(line);
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}
