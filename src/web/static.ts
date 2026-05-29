import { createReadStream, existsSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Config } from "../config.js";
import { attachmentsDir, browserScreenshotsDir, generatedAttachmentsDir } from "../generated-media.js";
import { sendText } from "./http.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST_DIR = resolve(PROJECT_ROOT, "web/dist");

// Only successful realpaths are cached: the attachment root dirs are created
// lazily on first write, so a missing root must stay retryable.
const rootRealPathCache = new Map<string, string>();

function mimeType(path: string): string {
	const extension = extname(path).toLowerCase();
	if (extension === ".html") return "text/html; charset=utf-8";
	if (extension === ".js") return "text/javascript; charset=utf-8";
	if (extension === ".css") return "text/css; charset=utf-8";
	if (extension === ".svg") return "image/svg+xml";
	if (extension === ".png") return "image/png";
	if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
	if (extension === ".gif") return "image/gif";
	if (extension === ".webp") return "image/webp";
	if (extension === ".ico") return "image/x-icon";
	if (extension === ".mp3") return "audio/mpeg";
	if (extension === ".opus" || extension === ".ogg") return "audio/ogg";
	if (extension === ".wav") return "audio/wav";
	return "application/octet-stream";
}

export async function serveStatic(response: ServerResponse, requestPath: string): Promise<boolean> {
	if (!existsSync(DIST_DIR)) return false;
	const pathname = decodeURIComponent(requestPath.split("?")[0] || "/");
	const candidate = resolve(DIST_DIR, pathname === "/" ? "index.html" : pathname.slice(1));
	if (!candidate.startsWith(DIST_DIR)) {
		sendText(response, 403, "Forbidden");
		return true;
	}
	let filePath = candidate;
	const fileStat = await stat(filePath).catch(() => undefined);
	if (!fileStat?.isFile()) filePath = join(DIST_DIR, "index.html");
	const stream = createReadStream(filePath);
	response.writeHead(200, { "content-type": mimeType(filePath) });
	stream.pipe(response);
	return true;
}

function parseRangeHeader(rangeHeader: string | undefined, size: number): { start: number; end: number } | undefined {
	if (!rangeHeader) return undefined;
	const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
	if (!match) return undefined;
	const [, rawStart, rawEnd] = match;
	if (!rawStart && !rawEnd) return undefined;
	if (!rawStart) {
		const suffixLength = Number(rawEnd);
		if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined;
		return { start: Math.max(0, size - suffixLength), end: size - 1 };
	}
	const start = Number(rawStart);
	const end = rawEnd ? Number(rawEnd) : size - 1;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
		return undefined;
	}
	return { start, end: Math.min(end, size - 1) };
}

export async function serveAttachment(
	config: Config,
	response: ServerResponse,
	requestPath: string,
	rangeHeader?: string,
): Promise<boolean> {
	const relativePath = decodeURIComponent(requestPath.replace(/^\/api\/web\/attachments\/?/, ""));
	if (!relativePath) {
		sendText(response, 404, "Not found");
		return true;
	}
	const candidates = [
		{ root: generatedAttachmentsDir(config), relativePath },
		{ root: attachmentsDir(config), relativePath },
		{ root: browserScreenshotsDir(config), relativePath: relativePath.replace(/^screenshot[\\/]/, "") },
	];
	for (const { root, relativePath: candidateRelativePath } of candidates) {
		let rootRealPath = rootRealPathCache.get(root);
		if (rootRealPath === undefined) {
			rootRealPath = await realpath(root).catch(() => undefined);
			if (!rootRealPath) continue;
			rootRealPathCache.set(root, rootRealPath);
		}
		const filePath = resolve(root, candidateRelativePath);
		const rel = relative(root, filePath);
		if (rel.startsWith("..") || rel.startsWith("/") || rel.startsWith("\\") || rel === "") {
			sendText(response, 403, "Forbidden");
			return true;
		}
		const linkStat = await lstat(filePath).catch(() => undefined);
		if (!linkStat) continue;
		if (linkStat.isSymbolicLink()) {
			sendText(response, 403, "Forbidden");
			return true;
		}
		const fileRealPath = await realpath(filePath).catch(() => undefined);
		if (!fileRealPath) continue;
		const realRel = relative(rootRealPath, fileRealPath);
		if (realRel.startsWith("..") || realRel.startsWith("/") || realRel.startsWith("\\") || realRel === "") {
			sendText(response, 403, "Forbidden");
			return true;
		}
		const fileStat = await stat(fileRealPath).catch(() => undefined);
		if (!fileStat?.isFile()) continue;
		const range = parseRangeHeader(rangeHeader, fileStat.size);
		if (range) {
			response.writeHead(206, {
				"content-type": mimeType(filePath),
				"content-length": String(range.end - range.start + 1),
				"content-range": `bytes ${range.start}-${range.end}/${fileStat.size}`,
				"accept-ranges": "bytes",
				"cache-control": "private, max-age=31536000, immutable",
			});
			createReadStream(fileRealPath, { start: range.start, end: range.end }).pipe(response);
			return true;
		}
		response.writeHead(200, {
			"content-type": mimeType(filePath),
			"content-length": String(fileStat.size),
			"accept-ranges": "bytes",
			"cache-control": "private, max-age=31536000, immutable",
		});
		createReadStream(fileRealPath).pipe(response);
		return true;
	}
	sendText(response, 404, "Not found");
	return true;
}
