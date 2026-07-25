import type { IncomingMessage } from "node:http";

import { MAX_INBOUND_TOTAL_BYTES } from "../media/attachment-limits.js";

export interface WebUploadAttachment {
	name?: string;
	mimeType?: string;
	size?: number;
	buffer: Buffer;
}

export function isWebUploadAttachment(value: unknown): value is WebUploadAttachment {
	return !!value && typeof value === "object" && Buffer.isBuffer((value as { buffer?: unknown }).buffer);
}

export function isMultipartContentType(contentType: string | string[]): boolean {
	return Array.isArray(contentType)
		? contentType.some((value) => value.includes("multipart/form-data"))
		: contentType.includes("multipart/form-data");
}

export async function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > maxBytes) throw new Error("Request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

export async function readMultipartBody(
	request: IncomingMessage,
	contentType: string | string[],
): Promise<Record<string, unknown>> {
	const raw = await readRawBody(request, MAX_INBOUND_TOTAL_BYTES);
	const header = Array.isArray(contentType)
		? (contentType.find((value) => value.includes("multipart/form-data")) ?? contentType[0] ?? "")
		: contentType;
	const form = await new Response(new Uint8Array(raw) as BodyInit, { headers: { "content-type": header } }).formData();
	const attachments: WebUploadAttachment[] = [];
	const body: Record<string, unknown> = { text: "" };
	for (const name of ["text", "channelKey", "clientId", "bookId"]) {
		const value = form.get(name);
		if (typeof value === "string") body[name] = value;
	}
	for (const value of form.getAll("attachments")) {
		if (typeof value === "string") continue;
		const buffer = Buffer.from(await value.arrayBuffer());
		if (buffer.length === 0) continue;
		attachments.push({
			name: value.name || undefined,
			mimeType: value.type || undefined,
			size: buffer.length,
			buffer,
		});
	}
	body.attachments = attachments;
	return body;
}
