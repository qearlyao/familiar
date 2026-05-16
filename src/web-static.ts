import { createReadStream, existsSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Config } from "./config.js";
import { attachmentsDir, browserScreenshotsDir, generatedAttachmentsDir } from "./generated-media.js";
import { sendText } from "./web-http.js";

function getProjectRoot(): string {
	return resolve(fileURLToPath(import.meta.url), "../..");
}

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
	const distDir = resolve(getProjectRoot(), "web/dist");
	if (!existsSync(distDir)) return false;
	const pathname = decodeURIComponent(requestPath.split("?")[0] || "/");
	const candidate = resolve(distDir, pathname === "/" ? "index.html" : pathname.slice(1));
	if (!candidate.startsWith(distDir)) {
		sendText(response, 403, "Forbidden");
		return true;
	}
	let filePath = candidate;
	const fileStat = await stat(filePath).catch(() => undefined);
	if (!fileStat?.isFile()) filePath = join(distDir, "index.html");
	const stream = createReadStream(filePath);
	response.writeHead(200, { "content-type": mimeType(filePath) });
	stream.pipe(response);
	return true;
}

export async function serveAttachment(config: Config, response: ServerResponse, requestPath: string): Promise<boolean> {
	const relativePath = decodeURIComponent(requestPath.replace(/^\/api\/web\/attachments\/?/, ""));
	if (!relativePath) {
		sendText(response, 404, "Not found");
		return true;
	}
	const candidates = [
		{ root: generatedAttachmentsDir(config), relativePath },
		{ root: attachmentsDir(config), relativePath },
		{ root: browserScreenshotsDir(), relativePath: relativePath.replace(/^screenshot[\\/]/, "") },
	];
	for (const { root, relativePath: candidateRelativePath } of candidates) {
		const rootRealPath = await realpath(root).catch(() => undefined);
		if (!rootRealPath) continue;
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
		response.writeHead(200, {
			"content-type": mimeType(filePath),
			"content-length": String(fileStat.size),
			"cache-control": "private, max-age=31536000, immutable",
		});
		createReadStream(fileRealPath).pipe(response);
		return true;
	}
	sendText(response, 404, "Not found");
	return true;
}
