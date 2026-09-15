import type { Dirent } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import type { Config } from "../config/index.js";
import { atomicWriteJson, isEnoent, readFileOrNull } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import { HttpError } from "./http.js";

export interface BookChapter {
	index: number;
	title: string;
	chars: number;
}

export interface BookRecord {
	id: string;
	title: string;
	author?: string;
	language?: string;
	format: "epub" | "text";
	createdAt: number;
	chapters: BookChapter[];
	toc: number[];
	cover?: { file: string };
}

export interface BookPosition {
	chapter: number;
	offsetRatio: number;
	updatedAt: number;
}

export interface BookSummary {
	id: string;
	title: string;
	author?: string;
	language?: string;
	format: BookRecord["format"];
	chapterCount: number;
	coverUrl?: string;
	createdAt: number;
	position?: BookPosition;
	percent?: number;
}

export interface BookDetail extends BookSummary {
	chapters: BookChapter[];
	toc: BookChapter[];
}

const BOOK_ID_RE = /^[a-f0-9]{10}$/;

export function booksDir(config: Config): string {
	return resolve(config.workspace.dataDir, "books");
}

export function assertBookId(id: string): string {
	if (!BOOK_ID_RE.test(id)) throw new HttpError(400, "invalid book id");
	return id;
}

export function bookDir(config: Config, id: string): string {
	return resolve(booksDir(config), assertBookId(id));
}

export async function listWebBooks(config: Config): Promise<BookSummary[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(booksDir(config), { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const books = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory() && BOOK_ID_RE.test(entry.name))
			.map(async (entry) =>
				bookSummary(await readBookRecord(config, entry.name), await readBookPosition(config, entry.name)),
			),
	);
	return books.sort((a, b) => {
		const aUpdated = a.position?.updatedAt ?? Number.NEGATIVE_INFINITY;
		const bUpdated = b.position?.updatedAt ?? Number.NEGATIVE_INFINITY;
		return bUpdated - aUpdated || b.createdAt - a.createdAt;
	});
}

export async function readWebBook(config: Config, id: string): Promise<BookDetail> {
	const book = await readBookRecord(config, id);
	return {
		...bookSummary(book, await readBookPosition(config, id)),
		chapters: book.chapters,
		toc: book.toc.map((index) => book.chapters[index]!),
	};
}

export async function readWebBookChapter(
	config: Config,
	id: string,
	index: number,
): Promise<BookChapter & { html: string; css?: string }> {
	const book = await readBookRecord(config, id);
	if (!Number.isSafeInteger(index) || index < 0 || index >= book.chapters.length) {
		throw new HttpError(404, "book chapter not found");
	}
	const chapter = book.chapters[index]!;
	try {
		const [html, css] = await Promise.all([
			readFile(resolve(bookDir(config, id), "chapters", `${index}.html`), "utf8"),
			readFileOrNull(resolve(bookDir(config, id), "styles.css"), "utf8"),
		]);
		return { ...chapter, html, ...(css ? { css } : {}) };
	} catch (error) {
		if (isEnoent(error)) throw new HttpError(404, "book chapter not found");
		throw error;
	}
}

export async function writeBookPosition(
	config: Config,
	id: string,
	chapter: number,
	offsetRatio: number,
): Promise<{ position: BookPosition; percent: number }> {
	const book = await readBookRecord(config, id);
	if (!Number.isSafeInteger(chapter) || chapter < 0 || chapter >= book.chapters.length) {
		throw new HttpError(400, "invalid book chapter");
	}
	if (!Number.isFinite(offsetRatio) || offsetRatio < 0 || offsetRatio > 1) {
		throw new HttpError(400, "offsetRatio must be between 0 and 1");
	}
	const position = { chapter, offsetRatio, updatedAt: Date.now() };
	await atomicWriteJson(resolve(bookDir(config, id), "state.json"), position);
	return { position, percent: bookPercent(book, position) };
}

export async function deleteWebBook(config: Config, id: string): Promise<void> {
	await readBookRecord(config, id);
	await rm(bookDir(config, id), { recursive: true });
}

export function bookPercent(book: Pick<BookRecord, "chapters">, position: BookPosition): number {
	const total = book.chapters.reduce((sum, chapter) => sum + chapter.chars, 0);
	if (total === 0) return 0;
	const completed = book.chapters.slice(0, position.chapter).reduce((sum, chapter) => sum + chapter.chars, 0);
	const current = book.chapters[position.chapter]?.chars ?? 0;
	return Math.min(100, Math.max(0, ((completed + current * position.offsetRatio) / total) * 100));
}

export async function readBookRecord(config: Config, id: string): Promise<BookRecord> {
	const path = resolve(bookDir(config, id), "book.json");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isEnoent(error)) throw new HttpError(404, "book not found");
		throw error;
	}
	return parseBookRecord(JSON.parse(raw));
}

async function readBookPosition(config: Config, id: string): Promise<BookPosition | undefined> {
	const raw = await readFileOrNull(resolve(bookDir(config, id), "state.json"), "utf8");
	if (raw === null) return undefined;
	const value: unknown = JSON.parse(raw);
	if (
		!isRecord(value) ||
		!Number.isSafeInteger(value.chapter) ||
		(value.chapter as number) < 0 ||
		typeof value.offsetRatio !== "number" ||
		value.offsetRatio < 0 ||
		value.offsetRatio > 1 ||
		typeof value.updatedAt !== "number" ||
		!Number.isFinite(value.updatedAt)
	) {
		throw new Error(`Invalid book state for ${id}`);
	}
	return { chapter: value.chapter as number, offsetRatio: value.offsetRatio, updatedAt: value.updatedAt };
}

function bookSummary(book: BookRecord, position?: BookPosition): BookSummary {
	if (position && position.chapter >= book.chapters.length) throw new Error(`Invalid book state for ${book.id}`);
	return {
		id: book.id,
		title: book.title,
		...(book.author ? { author: book.author } : {}),
		...(book.language ? { language: book.language } : {}),
		format: book.format,
		chapterCount: book.chapters.length,
		...(book.cover ? { coverUrl: `/api/web/books/assets/${book.id}/${book.cover.file}` } : {}),
		createdAt: book.createdAt,
		...(position ? { position, percent: bookPercent(book, position) } : {}),
	};
}

function parseBookRecord(value: unknown): BookRecord {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		!BOOK_ID_RE.test(value.id) ||
		typeof value.title !== "string" ||
		(value.author !== undefined && typeof value.author !== "string") ||
		(value.language !== undefined && typeof value.language !== "string") ||
		(value.format !== "epub" && value.format !== "text") ||
		typeof value.createdAt !== "number" ||
		!Number.isFinite(value.createdAt) ||
		!Array.isArray(value.chapters)
	) {
		throw new Error("Invalid book metadata");
	}
	const chapters = value.chapters.map((chapter, index) => {
		if (
			!isRecord(chapter) ||
			!Number.isSafeInteger(chapter.index) ||
			chapter.index !== index ||
			typeof chapter.title !== "string" ||
			typeof chapter.chars !== "number"
		) {
			throw new Error("Invalid book chapter metadata");
		}
		return { index: chapter.index as number, title: chapter.title, chars: chapter.chars };
	});
	const cover = value.cover;
	if (cover !== undefined && (!isRecord(cover) || typeof cover.file !== "string")) {
		throw new Error("Invalid book cover metadata");
	}
	const rawToc = value.toc;
	if (
		rawToc !== undefined &&
		(!Array.isArray(rawToc) ||
			rawToc.some(
				(index) => !Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= chapters.length,
			) ||
			new Set(rawToc).size !== rawToc.length)
	) {
		throw new Error("Invalid book contents metadata");
	}
	return {
		id: value.id,
		title: value.title,
		...(typeof value.author === "string" ? { author: value.author } : {}),
		...(typeof value.language === "string" ? { language: value.language } : {}),
		format: value.format,
		createdAt: value.createdAt,
		chapters,
		toc: rawToc === undefined ? chapters.map((chapter) => chapter.index) : rawToc.map((index) => index as number),
		...(cover ? { cover: { file: cover.file as string } } : {}),
	};
}
