import { extname } from "node:path";
import type { StoredAttachment } from "../conversation/chat-log.js";

/** the one extension → content type table; narrower lookups (images only) derive from it */
const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".htm": "text/html",
	".xhtml": "application/xhtml+xml",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".xml": "application/xml",
	".svg": "image/svg+xml",
	".webmanifest": "application/manifest+json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".tif": "image/tiff",
	".tiff": "image/tiff",
	".ico": "image/x-icon",
	".mp3": "audio/mpeg",
	".opus": "audio/ogg",
	".ogg": "audio/ogg",
	".wav": "audio/wav",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".pdf": "application/pdf",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".csv": "text/csv",
	".json": "application/json",
	".md": "text/markdown",
	".txt": "text/plain",
	".zip": "application/zip",
};

export function attachmentKindForMime(mimeType: string): NonNullable<StoredAttachment["kind"]> {
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("audio/")) return "audio";
	if (mimeType.startsWith("video/")) return "video";
	return "file";
}

export function mimeTypeForPath(path: string): string {
	return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** the header form: text types say they're utf-8 */
export function contentTypeForPath(path: string): string {
	const type = mimeTypeForPath(path);
	return type.startsWith("text/") || type === "application/json" ? `${type}; charset=utf-8` : type;
}
