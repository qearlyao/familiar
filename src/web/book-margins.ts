import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import type { Config } from "../config/index.js";
import type { ChatLogRecord } from "../conversation/chat-log.js";
import { atomicWriteJson, readFileOrNull } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import { type BookRecord, bookDir, readBookRecord } from "./book-library.js";
import { HttpError } from "./http.js";

/** Characters per book page. Pages are counted in text, not layout, so "p. 148" survives a font change. */
export const BOOK_PAGE_CHARS = 1500;

type MarginScale = "word" | "paragraph" | "page";

interface MarginAnchor {
	chapter: number;
	/** Start of the quote in the chapter's flattened text. */
	offset: number;
	scale: MarginScale;
	quote: string;
	prefix: string;
	suffix: string;
}

interface MarginMessage {
	id: string;
	author: "you" | "companion";
	text: string;
	createdAt: number;
	/** Where the turn ran; set on your messages so the reply can be found again. */
	channelKey?: string;
	/** Your message's reply state. Absent once her reply has been filed. */
	reply?: "waiting" | "quiet" | "failed";
	error?: string;
}

interface MarginEntry extends MarginAnchor {
	id: string;
	page: number;
	note?: string;
	thread: MarginMessage[];
	createdAt: number;
	updatedAt: number;
}

type StoredEntry = Omit<MarginEntry, "page">;

function bookPage(book: Pick<BookRecord, "chapters">, chapter: number, offset: number): number {
	const before = book.chapters.slice(0, chapter).reduce((sum, item) => sum + item.chars, 0);
	const total = book.chapters.reduce((sum, item) => sum + item.chars, 0);
	const pages = Math.max(1, Math.ceil(total / BOOK_PAGE_CHARS));
	return Math.min(pages, Math.floor((before + Math.max(0, offset)) / BOOK_PAGE_CHARS) + 1);
}

// ponytail: per-book in-process lock; one daemon owns the data dir.
const locks = new Map<string, Promise<unknown>>();
function withBookLock<T>(id: string, run: () => Promise<T>): Promise<T> {
	const next = (locks.get(id) ?? Promise.resolve()).then(run, run);
	locks.set(
		id,
		next.catch(() => undefined),
	);
	return next;
}

function marginsPath(config: Config, id: string): string {
	return resolve(bookDir(config, id), "marginalia.json");
}

async function readStored(config: Config, id: string): Promise<StoredEntry[]> {
	const raw = await readFileOrNull(marginsPath(config, id), "utf8");
	if (raw === null) return [];
	const value: unknown = JSON.parse(raw);
	if (!isRecord(value) || !Array.isArray(value.entries)) throw new Error(`Invalid marginalia for ${id}`);
	return value.entries as StoredEntry[];
}

function writeStored(config: Config, id: string, entries: StoredEntry[]): Promise<void> {
	return atomicWriteJson(marginsPath(config, id), { entries });
}

function newEntry(anchor: MarginAnchor, now: number): StoredEntry {
	return { id: randomBytes(8).toString("base64url"), ...anchor, thread: [], createdAt: now, updatedAt: now };
}

function withPage(book: BookRecord, entry: StoredEntry): MarginEntry {
	return { ...entry, page: bookPage(book, entry.chapter, entry.offset) };
}

const SCALE_WORDS: Record<MarginScale, string> = {
	word: "a few words",
	paragraph: "a paragraph",
	page: "the page i'm on",
};

function parseAnchor(chapterCount: number, value: Record<string, unknown>): MarginAnchor {
	const { chapter, offset, scale, quote, prefix, suffix } = value;
	if (!Number.isSafeInteger(chapter) || (chapter as number) < 0 || (chapter as number) >= chapterCount) {
		throw new HttpError(400, "invalid book chapter");
	}
	if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new HttpError(400, "offset is required");
	if (typeof scale !== "string" || !Object.hasOwn(SCALE_WORDS, scale))
		throw new HttpError(400, "scale must be word, paragraph, or page");
	if (typeof quote !== "string" || !quote.trim() || typeof prefix !== "string" || typeof suffix !== "string") {
		throw new HttpError(400, "quote, prefix, and suffix are required");
	}
	return { chapter: chapter as number, offset: offset as number, scale: scale as MarginScale, quote, prefix, suffix };
}

/**
 * Files her replies into waiting threads. The turn itself lives in the main
 * session's log, so the thread is reconciled from those records on read —
 * a restart mid-turn loses nothing.
 */
async function fileReplies(
	entries: StoredEntry[],
	recordsFor: (channelKey: string) => Promise<readonly ChatLogRecord[]>,
): Promise<boolean> {
	let changed = false;
	for (const entry of entries) {
		const asked = entry.thread.at(-1);
		if (asked?.author !== "you" || asked.reply !== "waiting" || !asked.channelKey) continue;
		const records = await recordsFor(asked.channelKey);
		const inbound = records.find((record) => record.type === "inbound" && record.messageId === asked.id);
		const outbound = records.find((record) => record.type === "outbound" && record.replyToMessageId === asked.id);
		if (outbound?.type === "outbound") {
			if (outbound.silent || !outbound.text.trim()) {
				asked.reply = "quiet";
			} else {
				delete asked.reply;
				entry.thread.push({
					id: outbound.webMessageId ?? `out_${outbound.recordId}`,
					author: "companion",
					text: outbound.text,
					createdAt: Date.parse(outbound.ts) || Date.now(),
				});
			}
			entry.updatedAt = Date.now();
			changed = true;
			continue;
		}
		const failed = inbound
			? records.find((record) => record.type === "job_failed" && record.triggerRecordId === inbound.recordId)
			: undefined;
		if (failed?.type === "job_failed") {
			asked.reply = "failed";
			asked.error = failed.error;
			entry.updatedAt = Date.now();
			changed = true;
		}
	}
	return changed;
}

export async function readBookMargins(
	config: Config,
	id: string,
	recordsFor: (channelKey: string) => Promise<readonly ChatLogRecord[]>,
): Promise<MarginEntry[]> {
	const book = await readBookRecord(config, id);
	return withBookLock(id, async () => {
		const entries = await readStored(config, id);
		if (await fileReplies(entries, recordsFor)) await writeStored(config, id, entries);
		return entries.map((entry) => withPage(book, entry));
	});
}

export async function createBookMargin(
	config: Config,
	id: string,
	input: Record<string, unknown>,
): Promise<MarginEntry> {
	const book = await readBookRecord(config, id);
	const anchor = parseAnchor(book.chapters.length, input);
	if (input.note !== undefined && typeof input.note !== "string") throw new HttpError(400, "note must be a string");
	return withBookLock(id, async () => {
		const entries = await readStored(config, id);
		const entry = newEntry(anchor, Date.now());
		if (typeof input.note === "string" && input.note.trim()) entry.note = input.note.trim();
		entries.push(entry);
		await writeStored(config, id, entries);
		return withPage(book, entry);
	});
}

export async function updateBookMargin(
	config: Config,
	id: string,
	entryId: string,
	note: string,
): Promise<MarginEntry> {
	const book = await readBookRecord(config, id);
	return withBookLock(id, async () => {
		const entries = await readStored(config, id);
		const entry = entries.find((candidate) => candidate.id === entryId);
		if (!entry) throw new HttpError(404, "marginalia entry not found");
		if (note.trim()) entry.note = note.trim();
		else delete entry.note;
		entry.updatedAt = Date.now();
		await writeStored(config, id, entries);
		return withPage(book, entry);
	});
}

export async function deleteBookMargin(config: Config, id: string, entryId: string): Promise<void> {
	await readBookRecord(config, id);
	await withBookLock(id, async () => {
		const entries = await readStored(config, id);
		const index = entries.findIndex((entry) => entry.id === entryId);
		if (index < 0) throw new HttpError(404, "marginalia entry not found");
		entries.splice(index, 1);
		await writeStored(config, id, entries);
	});
}

/**
 * Opens (or continues) a thread and records your message as waiting. Returns
 * the prompt text for the main session; the caller runs the turn.
 */
export async function askInBookMargin(
	config: Config,
	id: string,
	input: { entryId?: string; anchor?: Record<string, unknown>; text: string; messageId: string; channelKey: string },
): Promise<{ entry: MarginEntry; prompt: string }> {
	const book = await readBookRecord(config, id);
	const anchor = input.anchor ? parseAnchor(book.chapters.length, input.anchor) : undefined;
	return withBookLock(id, async () => {
		const entries = await readStored(config, id);
		const now = Date.now();
		let entry: StoredEntry | undefined;
		if (anchor) {
			entry = newEntry(anchor, now);
			entries.push(entry);
		} else {
			entry = entries.find((candidate) => candidate.id === input.entryId);
			if (!entry) throw new HttpError(404, "marginalia entry not found");
			if (entry.thread.at(-1)?.reply === "waiting") throw new HttpError(409, "still waiting on the last reply");
		}
		const opening = entry.thread.length === 0;
		const text = input.text.trim();
		entry.thread.push({
			id: input.messageId,
			author: "you",
			text,
			createdAt: now,
			channelKey: input.channelKey,
			reply: "waiting",
		});
		entry.updatedAt = now;
		await writeStored(config, id, entries);
		return { entry: withPage(book, entry), prompt: marginPrompt(book, entry, text, opening) };
	});
}

const REPLY_QUOTE_CHARS = 280;

/**
 * The blockquote ends on its citation line ("— *Title*, chapter · p. N"), which
 * the web chat recognizes and folds, so margin context doesn't flood the chat.
 */
function marginPrompt(book: BookRecord, entry: StoredEntry, text: string, opening: boolean): string {
	const chapter = book.chapters[entry.chapter];
	const cite = `— *${book.title}*, ${chapter?.title || `chapter ${entry.chapter + 1}`} · p. ${bookPage(book, entry.chapter, entry.offset)}`;
	const quote =
		opening || entry.quote.length <= REPLY_QUOTE_CHARS
			? entry.quote.trim()
			: `${entry.quote.slice(0, REPLY_QUOTE_CHARS).trim()}…`;
	const lead = opening ? `from the margin — ${SCALE_WORDS[entry.scale]}:` : "back in the margin, on:";
	const body = `${lead}\n\n> ${quote.replaceAll("\n", "\n> ")}\n> ${cite}`;
	return text ? `${body}\n\n${text}` : body;
}
