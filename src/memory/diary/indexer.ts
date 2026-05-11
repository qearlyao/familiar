import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { Config } from "../../config.js";
import type { ChunkIndexer, ChunkIndexResult } from "../index/chunk-indexer.js";
import { indexDiaryMarkdown } from "./chunks.js";

export const DIARY_INDEX_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

export type DiaryFileSkipReason = "not-dated-markdown" | "not-file";

export interface DiaryIndexerOptions {
	config: Config;
	indexer: ChunkIndexer;
	signal?: AbortSignal;
}

export interface IndexDiaryFileOptions extends DiaryIndexerOptions {
	path: string;
	skipInvalid?: boolean;
}

export interface DiaryFileIndexResult {
	path: string;
	sourceId: string;
	result: ChunkIndexResult;
}

export interface SkippedDiaryFileIndexResult {
	path: string;
	sourceId: string;
	skipped: true;
	reason: DiaryFileSkipReason;
}

export type IndexDiaryFileResult = DiaryFileIndexResult | SkippedDiaryFileIndexResult;

export interface IndexAllDiaryFilesResult {
	files: DiaryFileIndexResult[];
}

export function isDatedDiaryMarkdownFile(path: string): boolean {
	return DIARY_INDEX_FILE_RE.test(basename(path));
}

export async function listDiaryMarkdownFiles(config: Config): Promise<string[]> {
	let entries: Dirent<string>[];
	try {
		entries = await readdir(config.memory.diariesDir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) {
			console.info(`diary indexer found no diary directory at ${config.memory.diariesDir}; indexed 0 files`);
			return [];
		}
		throw error;
	}
	return entries
		.filter((entry) => entry.isFile() && DIARY_INDEX_FILE_RE.test(entry.name))
		.map((entry) => join(config.memory.diariesDir, entry.name))
		.sort();
}

function isEnoent(error: unknown): boolean {
	return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export async function indexDiaryFile(options: IndexDiaryFileOptions): Promise<IndexDiaryFileResult> {
	const path = resolveDiaryPath(options.config, options.path);
	const sourceId = basename(path);
	const skipInvalid = options.skipInvalid ?? true;

	if (!isDatedDiaryMarkdownFile(path)) {
		if (skipInvalid) return { path, sourceId, skipped: true, reason: "not-dated-markdown" };
		throw new Error(`Diary file must be named YYYY-MM-DD.md: ${path}`);
	}

	const fileStat = await stat(path);
	if (!fileStat.isFile()) {
		if (skipInvalid) return { path, sourceId, skipped: true, reason: "not-file" };
		throw new Error(`Diary path is not a file: ${path}`);
	}

	const markdown = await readFile(path, "utf8");
	const result = await indexDiaryMarkdown({
		indexer: options.indexer,
		path,
		markdown,
		signal: options.signal,
	});
	return { path, sourceId, result };
}

export async function indexAllDiaryFiles(options: DiaryIndexerOptions): Promise<IndexAllDiaryFilesResult> {
	const paths = await listDiaryMarkdownFiles(options.config);
	const files: DiaryFileIndexResult[] = [];
	for (const path of paths) {
		const result = await indexDiaryFile({ ...options, path });
		if (!("skipped" in result)) files.push(result);
	}
	return { files };
}

function resolveDiaryPath(config: Config, path: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(config.memory.diariesDir, path);
}
