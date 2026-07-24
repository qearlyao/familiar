import { lstat, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Config } from "../config/index.js";
import { isEnoent } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import {
	assertBookId,
	bookDir,
	createBookMarginalia,
	deleteBookMarginalia,
	deleteWebBook,
	listWebBooks,
	readBookMarginalia,
	readWebBook,
	readWebBookChapter,
	updateBookMarginalia,
	writeBookPosition,
} from "./book-library.js";
import { ingestBook } from "./epub-ingest.js";
import { HttpError, readJsonBody, sendJson, sendText } from "./http.js";
import { isMultipartContentType, isWebUploadAttachment, readMultipartBody } from "./multipart.js";
import type { RegisterWebRoute } from "./routes.js";
import { servePrivateFile } from "./static.js";

const ASSET_PREFIX = "/api/web/books/assets/";

export function registerWebBookRoutes(route: RegisterWebRoute, config: Config): void {
	route("POST", "/api/web/books", async (request, response) => {
		const contentType = request.headers["content-type"] ?? "";
		if (!isMultipartContentType(contentType)) throw new HttpError(400, "multipart form data is required");
		let body: Record<string, unknown>;
		try {
			body = await readMultipartBody(request, contentType);
		} catch (error) {
			if (error instanceof Error && error.message === "Request body too large") {
				throw new HttpError(413, "book upload exceeds 80 MB");
			}
			throw error;
		}
		const attachment = Array.isArray(body.attachments) ? body.attachments.find(isWebUploadAttachment) : undefined;
		if (!attachment) throw new HttpError(400, "book file is required");
		const ingested = await ingestBook(config, attachment);
		const { chapters: _chapters, ...book } = await readWebBook(config, ingested.id);
		sendJson(response, 201, { book });
	});

	route("GET", "/api/web/books", async (_request, response) => {
		sendJson(response, 200, { books: await listWebBooks(config) });
	});

	route("GET", "/api/web/book", async (_request, response, url) => {
		sendJson(response, 200, { book: await readWebBook(config, requiredBookId(url)) });
	});

	route("GET", "/api/web/book/chapter", async (_request, response, url) => {
		const id = requiredBookId(url);
		const rawIndex = url.searchParams.get("index") ?? "";
		if (!/^\d+$/.test(rawIndex)) throw new HttpError(400, "chapter index is required");
		sendJson(response, 200, await readWebBookChapter(config, id, Number(rawIndex)));
	});

	route("PUT", "/api/web/book/position", async (request, response) => {
		const body = await readJsonBody(request);
		if (!isRecord(body) || typeof body.id !== "string") throw new HttpError(400, "book id is required");
		if (typeof body.chapter !== "number") throw new HttpError(400, "chapter is required");
		if (typeof body.offsetRatio !== "number") throw new HttpError(400, "offsetRatio is required");
		const { percent } = await writeBookPosition(config, body.id, body.chapter, body.offsetRatio);
		sendJson(response, 200, { ok: true, percent });
	});

	route("GET", "/api/web/book/marginalia", async (_request, response, url) => {
		sendJson(response, 200, { entries: await readBookMarginalia(config, requiredBookId(url)) });
	});

	route("POST", "/api/web/book/marginalia", async (request, response) => {
		const body = await readJsonBody(request);
		if (!isRecord(body) || typeof body.id !== "string") throw new HttpError(400, "book id is required");
		if (typeof body.chapter !== "number") throw new HttpError(400, "chapter is required");
		if (typeof body.quote !== "string" || typeof body.prefix !== "string" || typeof body.suffix !== "string") {
			throw new HttpError(400, "quote, prefix, and suffix are required");
		}
		if (body.note !== undefined && typeof body.note !== "string") throw new HttpError(400, "note must be a string");
		const entry = await createBookMarginalia(config, body.id, {
			chapter: body.chapter,
			quote: body.quote,
			prefix: body.prefix,
			suffix: body.suffix,
			...(body.note !== undefined ? { note: body.note } : {}),
		});
		sendJson(response, 201, { entry });
	});

	route("PUT", "/api/web/book/marginalia", async (request, response) => {
		const { id, entryId, note } = marginaliaChangeBody(await readJsonBody(request));
		sendJson(response, 200, { entry: await updateBookMarginalia(config, id, entryId, note) });
	});

	route("DELETE", "/api/web/book/marginalia", async (request, response) => {
		const { id, entryId } = marginaliaChangeBody(await readJsonBody(request), false);
		await deleteBookMarginalia(config, id, entryId);
		sendJson(response, 200, { ok: true });
	});

	route("DELETE", "/api/web/book", async (request, response) => {
		const body = await readJsonBody(request);
		if (!isRecord(body) || typeof body.id !== "string") throw new HttpError(400, "book id is required");
		await deleteWebBook(config, body.id);
		sendJson(response, 200, { ok: true });
	});
}

export async function serveBookAsset(
	config: Config,
	response: ServerResponse,
	requestPath: string,
	rangeHeader?: string,
): Promise<boolean> {
	let requested: string;
	try {
		requested = decodeURIComponent(requestPath.slice(ASSET_PREFIX.length));
	} catch {
		throw new HttpError(400, "invalid book asset path");
	}
	const slash = requested.indexOf("/");
	if (slash < 1) throw new HttpError(400, "invalid book asset path");
	const id = assertBookId(requested.slice(0, slash));
	const assetPath = requested.slice(slash + 1);
	if (!assetPath || assetPath.includes("\0") || assetPath.includes("\\") || isAbsolute(assetPath)) {
		throw new HttpError(400, "invalid book asset path");
	}
	const root = resolve(bookDir(config, id), "assets");
	const filePath = guardedAssetPath(root, assetPath);
	const linkStat = await lstat(filePath).catch((error) => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!linkStat?.isFile() || linkStat.isSymbolicLink()) {
		sendText(
			response,
			linkStat?.isSymbolicLink() ? 403 : 404,
			linkStat?.isSymbolicLink() ? "Forbidden" : "Not found",
		);
		return true;
	}
	const [rootRealPath, fileRealPath] = await Promise.all([realpath(root), realpath(filePath)]);
	const realRelativePath = relative(rootRealPath, fileRealPath);
	if (realRelativePath === "" || realRelativePath.startsWith("..") || isAbsolute(realRelativePath)) {
		sendText(response, 403, "Forbidden");
		return true;
	}
	const fileStat = await stat(fileRealPath);
	servePrivateFile(response, fileRealPath, fileStat.size, rangeHeader);
	return true;
}

function requiredBookId(url: URL): string {
	return assertBookId(url.searchParams.get("id") ?? "");
}

function marginaliaChangeBody(body: unknown, requireNote = true): { id: string; entryId: string; note: string } {
	if (!isRecord(body) || typeof body.id !== "string") throw new HttpError(400, "book id is required");
	if (typeof body.entryId !== "string" || !body.entryId) throw new HttpError(400, "entryId is required");
	if (requireNote && typeof body.note !== "string") throw new HttpError(400, "note is required");
	return { id: body.id, entryId: body.entryId, note: typeof body.note === "string" ? body.note : "" };
}

function guardedAssetPath(root: string, assetPath: string): string {
	const path = resolve(root, assetPath);
	const relativePath = relative(root, path);
	if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new HttpError(400, "invalid book asset path");
	}
	if (relativePath.split(sep).join("/") !== assetPath) throw new HttpError(400, "invalid book asset path");
	return path;
}
