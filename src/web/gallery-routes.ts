import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Config } from "../config/index.js";
import { generatedAttachmentsDir, publicAttachmentPath } from "../media/generated-media.js";
import { atomicWriteJson, isEnoent, readFileOrNull } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import { imageMimeTypeFromPath } from "../util/image-mime.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { RegisterWebRoute } from "./routes.js";

export interface GalleryItem {
	id: string;
	name: string;
	kind: "image" | "audio";
	mimeType?: string;
	url: string;
	size: number;
	createdAt: number;
	note: string;
}

interface GalleryFileClassification {
	kind: GalleryItem["kind"];
	mimeType?: string;
}

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".opus", ".aac", ".flac"]);

export function registerWebGalleryRoutes(route: RegisterWebRoute, config: Config): void {
	route("GET", "/api/web/gallery", async (_request, response) => {
		sendJson(response, 200, { items: await listWebGallery(config) });
	});

	route("PUT", "/api/web/gallery/note", async (request, response) => {
		const body = await readJsonBody(request);
		const { id, note } = galleryNoteUpdateFromBody(body);
		sendJson(response, 200, { note: await writeWebGalleryNote(config, id, note) });
	});
}

export async function listWebGallery(config: Config): Promise<GalleryItem[]> {
	const root = generatedAttachmentsDir(config);
	const files = await listGeneratedMediaFiles(root);
	const items = await Promise.all(files.map((path) => readGalleryItem(config, root, path)));
	return items
		.filter((item): item is GalleryItem => item !== undefined)
		.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

async function listGeneratedMediaFiles(root: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}

	const files: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isFile()) {
			files.push(path);
		} else if (entry.isDirectory()) {
			files.push(...(await listGeneratedMediaSubdirectoryFiles(path)));
		}
	}
	return files;
}

async function listGeneratedMediaSubdirectoryFiles(dir: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	return entries.filter((entry) => entry.isFile()).map((entry) => join(dir, entry.name));
}

async function readGalleryItem(config: Config, root: string, path: string): Promise<GalleryItem | undefined> {
	const classification = classifyGalleryFile(path);
	if (!classification) return undefined;

	let fileStat: Stats;
	try {
		fileStat = await stat(path);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	if (!fileStat.isFile()) return undefined;

	const id = relative(root, path).split(sep).join("/");
	return {
		id,
		name: basename(path),
		kind: classification.kind,
		...(classification.mimeType ? { mimeType: classification.mimeType } : {}),
		url: publicAttachmentPath(config, path),
		size: fileStat.size,
		createdAt: fileStat.birthtimeMs > 0 ? fileStat.birthtimeMs : fileStat.mtimeMs,
		note: await readGalleryNote(config, id),
	};
}

function classifyGalleryFile(path: string): GalleryFileClassification | undefined {
	const mimeType = imageMimeTypeFromPath(path);
	if (mimeType) return { kind: "image", mimeType };
	if (AUDIO_EXTENSIONS.has(extname(path).toLowerCase())) return { kind: "audio" };
	return undefined;
}

async function readGalleryNote(config: Config, id: string): Promise<string> {
	const raw = await readFileOrNull(galleryNotePath(config, id), "utf8");
	if (!raw) return "";
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) && typeof parsed.note === "string" ? parsed.note : "";
	} catch {
		return "";
	}
}

export async function writeWebGalleryNote(config: Config, id: string, note: string): Promise<string> {
	const canonicalId = await requireGalleryItemId(config, id);
	const path = galleryNotePath(config, canonicalId);
	if (note === "") {
		try {
			await rm(path);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		return note;
	}
	await atomicWriteJson(path, { note, updatedAt: new Date().toISOString() });
	return note;
}

async function requireGalleryItemId(config: Config, id: string): Promise<string> {
	const root = generatedAttachmentsDir(config);
	const path = galleryFilePathFromId(root, id);
	const linkStat = await lstat(path).catch((error) => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!linkStat?.isFile() || !classifyGalleryFile(path)) throw new HttpError(404, "gallery item not found");
	return relative(root, path).split(sep).join("/");
}

function galleryFilePathFromId(root: string, id: string): string {
	if (id === "" || id.includes("\0")) throw new HttpError(400, "invalid gallery id");
	const path = resolve(root, id);
	const relativePath = relative(root, path);
	if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new HttpError(400, "invalid gallery id");
	}
	const canonicalId = relativePath.split(sep).join("/");
	if (canonicalId !== id) throw new HttpError(400, "invalid gallery id");
	return path;
}

function galleryNotePath(config: Config, id: string): string {
	return resolve(config.workspace.dataDir, "attachments", "notes", `${sha256hex(id)}.json`);
}

function sha256hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function galleryNoteUpdateFromBody(body: unknown): { id: string; note: string } {
	if (!isRecord(body) || typeof body.id !== "string") throw new HttpError(400, "gallery id is required");
	if (typeof body.note !== "string") throw new HttpError(400, "note is required");
	return { id: body.id, note: body.note };
}
