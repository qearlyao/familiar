import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { Config } from "../config/index.js";
import { DIARY_INDEX_FILE_RE, listDiaryMarkdownFiles } from "../memory/diary/indexer.js";
import { isEnoent } from "../util/fs.js";
import { HttpError, sendJson } from "./http.js";
import type { RegisterWebRoute } from "./routes.js";

export interface WebDiarySummary {
	date: string;
	sourceId: string;
	title: string;
	excerpt: string;
	mtimeMs: number;
	sizeBytes: number;
}

export interface WebDiaryEntry extends WebDiarySummary {
	content: string;
}

const FRONTMATTER_RE = /^\s*---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/;
const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/m;
const DIARY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerWebDiaryRoutes(route: RegisterWebRoute, config: Config): void {
	route("GET", "/api/web/diaries", async (_request, response) => {
		sendJson(response, 200, { diaries: await listWebDiaries(config) });
	});

	route("GET", "/api/web/diary", async (_request, response, url) => {
		const date = url.searchParams.get("date") ?? "";
		sendJson(response, 200, { diary: await readWebDiary(config, date) });
	});
}

export async function listWebDiaries(config: Config): Promise<WebDiarySummary[]> {
	const paths = await listDiaryMarkdownFiles(config);
	const summaries = await Promise.all(paths.map(async (path) => toDiarySummary(await readDiaryPayload(path))));
	return summaries.sort((a, b) => b.date.localeCompare(a.date));
}

export async function readWebDiary(config: Config, date: string): Promise<WebDiaryEntry> {
	if (!DIARY_DATE_RE.test(date)) throw new HttpError(400, "diary date must be YYYY-MM-DD");
	const path = resolve(config.memory.diariesDir, `${date}.md`);
	try {
		return await readDiaryPayload(path);
	} catch (error) {
		if (isEnoent(error)) throw new HttpError(404, "diary not found");
		throw error;
	}
}

async function readDiaryPayload(path: string): Promise<WebDiaryEntry> {
	const sourceId = basename(path);
	if (!DIARY_INDEX_FILE_RE.test(sourceId)) {
		throw new HttpError(400, "diary file must be named YYYY-MM-DD.md");
	}
	const fileStat = await stat(path);
	if (!fileStat.isFile()) throw new HttpError(404, "diary not found");
	const markdown = await readFile(path, "utf8");
	const content = stripFrontmatter(markdown).trim();
	const date = sourceId.slice(0, -".md".length);
	return {
		date,
		sourceId,
		title: diaryTitle(content, date),
		excerpt: diaryExcerpt(content),
		mtimeMs: Math.floor(fileStat.mtimeMs),
		sizeBytes: fileStat.size,
		content,
	};
}

function stripFrontmatter(markdown: string): string {
	return markdown.replace(FRONTMATTER_RE, "");
}

function toDiarySummary(entry: WebDiaryEntry): WebDiarySummary {
	return {
		date: entry.date,
		sourceId: entry.sourceId,
		title: entry.title,
		excerpt: entry.excerpt,
		mtimeMs: entry.mtimeMs,
		sizeBytes: entry.sizeBytes,
	};
}

function diaryTitle(content: string, date: string): string {
	return stripInlineMarkdown(HEADING_RE.exec(content)?.[1]?.trim() || date);
}

function diaryExcerpt(content: string): string {
	const body = content
		.split(/\r?\n/)
		.filter((line) => !HEADING_RE.test(line))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return stripInlineMarkdown(body).slice(0, 180);
}

function stripInlineMarkdown(value: string): string {
	return value
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/[*_~#>]/g, "")
		.trim();
}
