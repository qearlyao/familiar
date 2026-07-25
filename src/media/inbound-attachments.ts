import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { Config } from "../config/index.js";
import type { StoredAttachment } from "../conversation/chat-log.js";
import { IMAGE_EXTENSION_BY_MIME, sniffImageMimeType } from "../util/image-mime.js";
import { MAX_INBOUND_ATTACHMENT_BYTES, MAX_INBOUND_ATTACHMENTS, MAX_INBOUND_TOTAL_BYTES } from "./attachment-limits.js";
import { attachmentsDir } from "./generated-media.js";
import { ensureInlineImageDerivative, MAX_INLINE_IMAGE_BASE64_BYTES } from "./image-derivatives.js";
import { deriveInboundAttachmentText } from "./media-understanding.js";

export {
	MAX_INBOUND_ATTACHMENT_BYTES,
	MAX_INBOUND_ATTACHMENTS,
	MAX_INBOUND_TOTAL_BYTES,
} from "./attachment-limits.js";
export { MAX_INLINE_IMAGE_BASE64_BYTES } from "./image-derivatives.js";

const TEXT_ATTACHMENT_PREVIEW_LINES = 2;
const TEXT_ATTACHMENT_PREVIEW_CHARS = 1000;
const MP4_FILE_TYPE_BRANDS = new Set(["avc1", "dash", "iso2", "isom", "M4V ", "mp41", "mp42", "MSNV"]);
const AUDIO_CONTAINER_MIME_TYPES = new Set(["audio/mp4", "audio/webm"]);

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

const ATTACHMENT_MIME_POLICY = {
	...Object.fromEntries(
		Object.entries(IMAGE_EXTENSION_BY_MIME).map(([mimeType, extension]) => [
			mimeType,
			{ kind: "image" as const, extension },
		]),
	),
	"audio/mpeg": { kind: "audio", extension: ".mp3" },
	"audio/ogg": { kind: "audio", extension: ".ogg" },
	"audio/wav": { kind: "audio", extension: ".wav" },
	"audio/webm": { kind: "audio", extension: ".webm" },
	"audio/mp4": { kind: "audio", extension: ".m4a" },
	"video/mp4": { kind: "video", extension: ".mp4" },
	"video/quicktime": { kind: "video", extension: ".mov" },
	"video/webm": { kind: "video", extension: ".webm" },
	"application/pdf": { kind: "file", extension: ".pdf" },
	"text/plain": { kind: "file", extension: ".txt" },
} satisfies Record<string, { kind: StoredAttachment["kind"]; extension: string }>;

const MIME_TYPE_BY_EXTENSION = Object.fromEntries(
	Object.entries(ATTACHMENT_MIME_POLICY)
		.filter(([, policy]) => policy.kind === "video")
		.map(([mimeType, policy]) => [policy.extension, mimeType]),
) as Record<string, keyof typeof ATTACHMENT_MIME_POLICY>;

function mimePolicy(mimeType: string) {
	return ATTACHMENT_MIME_POLICY[mimeType as keyof typeof ATTACHMENT_MIME_POLICY];
}

function safeName(name: string | undefined, fallback: string): string {
	const base = basename(name || fallback)
		.replace(/[^A-Za-z0-9._=-]+/g, "_")
		.slice(0, 120);
	return base || fallback;
}

function textAttachmentPreview(buffer: Buffer, mimeType: string): string | undefined {
	if (mimeType !== "text/plain") return undefined;
	const decoded = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
	const normalized = decoded.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	if (!normalized || normalized.includes("\uFFFD")) return undefined;
	const lines = normalized.split("\n").slice(0, TEXT_ATTACHMENT_PREVIEW_LINES);
	const preview = lines.join("\n").slice(0, TEXT_ATTACHMENT_PREVIEW_CHARS).trim();
	return preview || undefined;
}

function sniffText(buffer: Buffer): string | undefined {
	if (buffer.length === 0) return "text/plain";
	const head = buffer.subarray(0, Math.min(buffer.length, 512));
	if (head.includes(0)) return undefined;
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(head);
	} catch {
		return undefined;
	}
	for (const char of decoded) {
		const code = char.codePointAt(0) ?? 0;
		if (code === 9 || code === 10 || code === 13) continue;
		if (code < 32 || code === 127) return undefined;
	}
	return "text/plain";
}

function mimeFromExtension(name?: string): string | undefined {
	if (!name) return undefined;
	return MIME_TYPE_BY_EXTENSION[extname(name).toLowerCase()];
}

function sniffVideoMimeType(buffer: Buffer): string | undefined {
	if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
	if (buffer.length < 12 || buffer.subarray(4, 8).toString("ascii") !== "ftyp") return undefined;
	const brand = buffer.subarray(8, 12).toString("ascii");
	if (brand === "qt  ") return "video/quicktime";
	return MP4_FILE_TYPE_BRANDS.has(brand) ? "video/mp4" : undefined;
}

function declaredAudioContainerMime(input: IncomingAttachment): string | undefined {
	const mimeType = input.mimeType && mimePolicy(input.mimeType) ? input.mimeType : undefined;
	if (!mimeType || !AUDIO_CONTAINER_MIME_TYPES.has(mimeType)) return undefined;
	return input.source === "web" ? mimeType : undefined;
}

function sniffMimeType(input: IncomingAttachment, buffer: Buffer): string {
	const declaredMime = input.mimeType && mimePolicy(input.mimeType) ? input.mimeType : undefined;
	let detected = sniffImageMimeType(buffer);
	if (!detected && buffer.subarray(0, 4).toString("ascii") === "%PDF") detected = "application/pdf";
	else if (
		buffer.subarray(0, 3).toString("ascii") === "ID3" ||
		buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfb]))
	) {
		detected = "audio/mpeg";
	} else if (buffer.subarray(0, 4).toString("ascii") === "OggS") detected = "audio/ogg";
	else if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE") {
		detected = "audio/wav";
	}
	detected ??= sniffVideoMimeType(buffer);
	const mime =
		(detected === "video/mp4" || detected === "video/webm" ? declaredAudioContainerMime(input) : undefined) ??
		detected ??
		sniffText(buffer) ??
		declaredMime ??
		mimeFromExtension(input.name);
	if (!mime || !mimePolicy(mime)) {
		throw new Error(`Unsupported attachment type: ${input.mimeType || detected || "unknown"}`);
	}
	return mime;
}

function canonicalName(name: string | undefined, fallbackStem: string, mimeType: string): string {
	const current = safeName(name, fallbackStem);
	const stem = current.replace(/\.[^.]+$/, "");
	return `${stem}${mimePolicy(mimeType)?.extension || extname(current) || ""}`;
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
		const mimeType = sniffMimeType(input, buffer);
		const id = input.id || randomUUID();
		const cleanName = canonicalName(input.name, `attachment-${index + 1}`, mimeType);
		const sha256 = createHash("sha256").update(buffer).digest("hex");
		prepared.push({
			id,
			name: cleanName,
			kind: mimePolicy(mimeType)?.kind ?? "file",
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
			const textPreview = textAttachmentPreview(attachment.buffer, attachment.mimeType);
			if (textPreview) {
				finalAttachment.derived = {
					...finalAttachment.derived,
					text: {
						provider: "local",
						model: "text-preview",
						label: "preview",
						text: textPreview,
					},
				};
			}
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
			const attrs = [
				`name="${attachment.name}"`,
				`id="${attachment.id}"`,
				`kind="${attachment.kind ?? "file"}"`,
				`mime="${attachment.mimeType ?? "unknown"}"`,
				`size="${attachment.size ?? "unknown"}"`,
				attachment.localPath ? `path="${attachment.localPath}"` : undefined,
			]
				.filter(Boolean)
				.join(" ");
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
