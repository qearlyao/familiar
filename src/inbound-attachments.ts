import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";

import type { StoredAttachment } from "./chat-log.js";
import type { Config } from "./config.js";
import { attachmentsDir, publicAttachmentPath } from "./generated-media.js";
import { ensureInlineImageDerivative, MAX_INLINE_IMAGE_BASE64_BYTES } from "./image-derivatives.js";
import { deriveInboundAttachmentText } from "./media-understanding.js";

export { MAX_INLINE_IMAGE_BASE64_BYTES } from "./image-derivatives.js";

export const MAX_INBOUND_ATTACHMENTS = 4;
export const MAX_INBOUND_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const MAX_INBOUND_TOTAL_BYTES = 24 * 1024 * 1024;

type AttachmentSource = "discord" | "web";

export interface IncomingAttachment {
	id?: string;
	name?: string;
	mimeType?: string;
	size?: number;
	url?: string;
	buffer?: Buffer;
	source: AttachmentSource;
}

export interface PromptImages {
	promptSuffix: string;
	images: ImageContent[];
}

const ALLOWED_MIME_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"audio/mpeg",
	"audio/ogg",
	"audio/wav",
	"audio/webm",
	"video/mp4",
	"video/webm",
	"application/pdf",
	"text/plain",
]);

const EXTENSIONS_BY_MIME: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"audio/mpeg": ".mp3",
	"audio/ogg": ".ogg",
	"audio/wav": ".wav",
	"audio/webm": ".webm",
	"video/mp4": ".mp4",
	"video/webm": ".webm",
	"application/pdf": ".pdf",
	"text/plain": ".txt",
};

function safeName(name: string | undefined, fallback: string): string {
	const base = basename(name || fallback)
		.replace(/[^A-Za-z0-9._=-]+/g, "_")
		.slice(0, 120);
	return base || fallback;
}

function kindFromMime(mimeType: string): StoredAttachment["kind"] {
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("audio/")) return "audio";
	if (mimeType.startsWith("video/")) return "video";
	return "file";
}

function sniffText(buffer: Buffer): string | undefined {
	if (buffer.length === 0) return "text/plain";
	const head = buffer.subarray(0, Math.min(buffer.length, 512));
	if (head.includes(0)) return undefined;
	return head.every((byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126))
		? "text/plain"
		: undefined;
}

function sniffMimeType(buffer: Buffer, declared?: string): string {
	let detected: string | undefined;
	if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) detected = "image/jpeg";
	else if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		detected = "image/png";
	} else if (
		buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
		buffer.subarray(0, 6).toString("ascii") === "GIF89a"
	) {
		detected = "image/gif";
	} else if (
		buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
		buffer.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		detected = "image/webp";
	} else if (buffer.subarray(0, 4).toString("ascii") === "%PDF") detected = "application/pdf";
	else if (
		buffer.subarray(0, 3).toString("ascii") === "ID3" ||
		buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfb]))
	) {
		detected = "audio/mpeg";
	} else if (buffer.subarray(0, 4).toString("ascii") === "OggS") detected = "audio/ogg";
	else if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE") {
		detected = "audio/wav";
	}
	const mime = detected ?? sniffText(buffer) ?? declared;
	if (!mime || !ALLOWED_MIME_TYPES.has(mime)) {
		throw new Error(`Unsupported attachment type: ${declared || detected || "unknown"}`);
	}
	return mime;
}

function canonicalName(name: string | undefined, fallbackStem: string, mimeType: string): string {
	const current = safeName(name, fallbackStem);
	const stem = current.replace(/\.[^.]+$/, "");
	return `${stem}${EXTENSIONS_BY_MIME[mimeType] || extname(current) || ""}`;
}

interface PreparedAttachment {
	id: string;
	name: string;
	kind: StoredAttachment["kind"];
	mimeType: string;
	size: number;
	buffer: Buffer;
	remoteUrl?: string;
	sourceUrl?: string;
	source: AttachmentSource;
	sha256: string;
}

async function fetchRemoteAttachment(input: IncomingAttachment, signal: AbortSignal): Promise<Buffer> {
	if (!input.url) throw new Error("Attachment URL is required");
	const response = await fetch(input.url, { signal });
	if (!response.ok) throw new Error(`Attachment download failed: HTTP ${response.status}`);
	const contentLength = Number(response.headers.get("content-length") ?? 0);
	if (contentLength > MAX_INBOUND_ATTACHMENT_BYTES) {
		throw new Error(`Attachment is too large: ${contentLength} bytes`);
	}
	const reader = response.body?.getReader();
	if (!reader) {
		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);
		if (buffer.byteLength > MAX_INBOUND_ATTACHMENT_BYTES) {
			throw new Error(`Attachment is too large: ${buffer.byteLength} bytes`);
		}
		return buffer;
	}
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = Buffer.from(value);
			total += chunk.byteLength;
			if (total > MAX_INBOUND_ATTACHMENT_BYTES) {
				throw new Error(`Attachment is too large: ${total} bytes`);
			}
			chunks.push(chunk);
		}
		return Buffer.concat(chunks);
	} finally {
		reader.releaseLock();
	}
}

async function attachmentBuffer(input: IncomingAttachment): Promise<Buffer> {
	if (input.buffer) {
		if (input.buffer.byteLength > MAX_INBOUND_ATTACHMENT_BYTES) {
			throw new Error(`Attachment is too large: ${input.buffer.byteLength} bytes`);
		}
		return input.buffer;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		return await fetchRemoteAttachment(input, controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

export async function materializeInboundAttachments(
	config: Config,
	inputs: IncomingAttachment[],
): Promise<StoredAttachment[]> {
	if (inputs.length > MAX_INBOUND_ATTACHMENTS) {
		throw new Error(`Too many attachments: max ${MAX_INBOUND_ATTACHMENTS}`);
	}
	const prepared: PreparedAttachment[] = [];
	let totalBytes = 0;
	for (const [index, input] of inputs.entries()) {
		const buffer = await attachmentBuffer(input);
		totalBytes += buffer.byteLength;
		if (totalBytes > MAX_INBOUND_TOTAL_BYTES) {
			throw new Error(`Attachments are too large: max ${MAX_INBOUND_TOTAL_BYTES} bytes total`);
		}
		const mimeType = sniffMimeType(buffer, input.mimeType);
		const id = input.id || randomUUID();
		const cleanName = canonicalName(input.name, `attachment-${index + 1}`, mimeType);
		const sha256 = createHash("sha256").update(buffer).digest("hex");
		prepared.push({
			id,
			name: cleanName,
			kind: kindFromMime(mimeType),
			mimeType,
			size: buffer.byteLength,
			sha256,
			buffer,
			remoteUrl: input.url,
			sourceUrl: input.url,
			source: input.source,
		});
	}
	const stored: StoredAttachment[] = [];
	const writtenPaths: string[] = [];
	const existingDerivedPaths = await knownDerivedImagePaths(config);
	try {
		for (const attachment of prepared) {
			const dir = resolve(attachmentsDir(config), "inbound", attachment.source);
			await mkdir(dir, { recursive: true });
			const localPath = resolve(dir, `${Date.now()}-${attachment.id}-${attachment.name}`);
			await writeFile(localPath, attachment.buffer);
			writtenPaths.push(localPath);
			const finalAttachment: StoredAttachment = {
				id: attachment.id,
				name: attachment.name,
				kind: attachment.kind,
				mimeType: attachment.mimeType,
				size: attachment.size,
				remoteUrl: attachment.remoteUrl,
				sourceUrl: attachment.sourceUrl,
				localPath,
				source: attachment.source,
				sha256: attachment.sha256,
			};
			const derivedImage = await ensureInlineImageDerivative(config, finalAttachment);
			if (derivedImage) {
				if (derivedImage.localPath && !existingDerivedPaths.has(derivedImage.localPath)) {
					writtenPaths.push(derivedImage.localPath);
					existingDerivedPaths.add(derivedImage.localPath);
				}
				finalAttachment.derived = {
					...finalAttachment.derived,
					image: derivedImage,
				};
			}
			stored.push(finalAttachment);
		}
		return await deriveInboundAttachmentText(config, stored);
	} catch (error) {
		await Promise.all(writtenPaths.map((path) => unlink(path).catch(() => undefined)));
		throw error;
	}
}

async function knownDerivedImagePaths(config: Config): Promise<Set<string>> {
	const dir = resolve(attachmentsDir(config), "derived", "image");
	const entries = await readdir(dir).catch(() => []);
	return new Set(entries.map((entry) => resolve(dir, entry)));
}

export async function promptImagesFromAttachments(attachments: StoredAttachment[]): Promise<PromptImages> {
	const images: ImageContent[] = [];
	const notes: string[] = [];
	for (const attachment of attachments) {
		if (!attachment.localPath || !attachment.mimeType?.startsWith("image/")) continue;
		if (attachment.kind && attachment.kind !== "image") continue;
		const imageMeta = attachment.derived?.image;
		const imagePath = imageMeta?.localPath || attachment.localPath;
		const data = (await readFile(imagePath)).toString("base64");
		if (Buffer.byteLength(data, "utf8") > MAX_INLINE_IMAGE_BASE64_BYTES) {
			notes.push(
				`<attachment name="${attachment.name}" mime="${attachment.mimeType}">[Image omitted from model input: inline payload is too large.]</attachment>`,
			);
			continue;
		}
		images.push({
			type: "image",
			mimeType: imageMeta?.mimeType ?? attachment.mimeType,
			data,
		});
		const detail = imageMeta?.note ? ` ${imageMeta.note}` : "";
		notes.push(`<attachment name="${attachment.name}" mime="${attachment.mimeType}">${detail}</attachment>`);
	}
	return {
		images,
		promptSuffix: notes.join("\n"),
	};
}

export function promptAttachmentNotes(attachments: StoredAttachment[]): string {
	return attachments
		.map((attachment) => {
			const attrs = `name="${attachment.name}" id="${attachment.id}" kind="${attachment.kind ?? "file"}" mime="${attachment.mimeType ?? "unknown"}" size="${attachment.size ?? "unknown"}"`;
			const derivedText = attachment.derived?.text?.text;
			if (derivedText) {
				const label =
					attachment.derived?.text?.label || (attachment.kind === "audio" ? "transcription" : "summary");
				return `<attachment ${attrs}>[${label}: ${derivedText}]</attachment>`;
			}
			return `<attachment ${attrs}></attachment>`;
		})
		.join("\n")
		.trim();
}

export function publicInboundAttachmentPath(config: Config, localPath: string): string {
	return publicAttachmentPath(config, localPath);
}
