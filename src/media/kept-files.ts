import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { copyFile, mkdir, open, readdir, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { Config } from "../config/index.js";
import { atomicWriteJson, isEnoent, readFileOrNull } from "../util/fs.js";

/**
 * Documents the agent sent (pages, markdown, pdfs, ...) kept on the library shelf.
 * Chat copies expire with generated media; these stay until someone takes them off.
 * One entry per source file: sending the same workspace file again replaces the kept copy.
 */
export interface KeptFile {
	id: string;
	name: string;
	mimeType: string;
	size: number;
	/** where it came from, workspace-relative when it lived in the workspace */
	source: string;
	createdAt: number;
	updatedAt: number;
	/** the opening of a text-like file, for the card on the shelf */
	excerpt?: string;
	url: string;
}

type KeptFileRecord = Omit<KeptFile, "url">;

const KEPT_ID_RE = /^[a-f0-9]{12}$/;
const EXCERPT_BYTES = 1200;
export const KEPT_FILE_URL_PREFIX = "/api/web/library/kept/";

function keptDir(config: Config, id = ""): string {
	return resolve(config.workspace.dataDir, "library", "kept", id);
}

function keptFileUrl(record: KeptFileRecord): string {
	// the version query busts the immutable cache when a resend replaces the file
	return `${KEPT_FILE_URL_PREFIX}${record.id}/${encodeURIComponent(record.name)}?v=${record.updatedAt}`;
}

export async function keepSentFile(
	config: Config,
	sent: { sourcePath: string; copyFrom: string; name: string; mimeType: string; size: number },
): Promise<KeptFile> {
	const sourcePath = resolve(sent.sourcePath);
	const id = createHash("sha256").update(sourcePath).digest("hex").slice(0, 12);
	const dir = keptDir(config, id);
	const previous = await readKeptRecord(config, id);
	await rm(resolve(dir, "file"), { recursive: true, force: true });
	await mkdir(resolve(dir, "file"), { recursive: true });
	await copyFile(sent.copyFrom, resolve(dir, "file", sent.name), constants.COPYFILE_FICLONE);
	const fromWorkspace = relative(config.workspacePath, sourcePath);
	const excerpt = isTextLike(sent.mimeType) ? await readExcerpt(sent.copyFrom) : undefined;
	const now = Date.now();
	const record: KeptFileRecord = {
		id,
		name: sent.name,
		mimeType: sent.mimeType,
		size: sent.size,
		source: fromWorkspace && !fromWorkspace.startsWith("..") ? fromWorkspace : sourcePath,
		createdAt: previous?.createdAt ?? now,
		updatedAt: Math.max(now, (previous?.updatedAt ?? 0) + 1),
		excerpt,
	};
	await atomicWriteJson(resolve(dir, "record.json"), record);
	return { ...record, url: keptFileUrl(record) };
}

export async function listKeptFiles(config: Config): Promise<KeptFile[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(keptDir(config), { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const records = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory() && KEPT_ID_RE.test(entry.name))
			.map((entry) => readKeptRecord(config, entry.name)),
	);
	return records
		.filter((record): record is KeptFileRecord => record !== undefined)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.map((record) => ({ ...record, url: keptFileUrl(record) }));
}

/** the kept copy's path, or undefined when no such entry exists */
export async function findKeptFile(config: Config, id: string): Promise<{ name: string; path: string } | undefined> {
	const record = await readKeptRecord(config, id);
	if (!record) return undefined;
	return { name: record.name, path: resolve(keptDir(config, id), "file", record.name) };
}

export async function removeKeptFile(config: Config, id: string): Promise<boolean> {
	if (!(await readKeptRecord(config, id))) return false;
	await rm(keptDir(config, id), { recursive: true });
	return true;
}

async function readKeptRecord(config: Config, id: string): Promise<KeptFileRecord | undefined> {
	if (!KEPT_ID_RE.test(id)) return undefined;
	const raw = await readFileOrNull(resolve(keptDir(config, id), "record.json"), "utf8");
	if (!raw) return undefined;
	const parsed = JSON.parse(raw) as KeptFileRecord;
	return parsed.id === id ? parsed : undefined;
}

function isTextLike(mimeType: string): boolean {
	return (mimeType.startsWith("text/") && mimeType !== "text/html") || mimeType === "application/json";
}

async function readExcerpt(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(EXCERPT_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, EXCERPT_BYTES, 0);
		// a cut multi-byte character decodes to U+FFFD at the very end; drop it
		return buffer
			.subarray(0, bytesRead)
			.toString("utf8")
			.replace(/\uFFFD+$/, "")
			.trim();
	} finally {
		await handle.close();
	}
}
