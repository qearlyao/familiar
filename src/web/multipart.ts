import type { IncomingMessage } from "node:http";

export interface WebUploadAttachment {
	name?: string;
	mimeType?: string;
	size?: number;
	buffer: Buffer;
}

export function isWebUploadAttachment(value: unknown): value is WebUploadAttachment {
	return !!value && typeof value === "object" && Buffer.isBuffer((value as { buffer?: unknown }).buffer);
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

export function multipartBoundary(contentType: string | string[]): string {
	const header = Array.isArray(contentType) ? contentType.find((value) => value.includes("boundary=")) : contentType;
	const match = header?.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
	if (!match?.[1] && !match?.[2]) throw new Error("Missing multipart boundary");
	return match[1] ?? match[2] ?? "";
}

export function parseContentDisposition(header: string): Record<string, string> {
	const parts = header.split(";").map((part) => part.trim());
	const values: Record<string, string> = {};
	for (const part of parts.slice(1)) {
		const [key, rawValue] = part.split("=");
		if (!key || rawValue === undefined) continue;
		values[key.toLowerCase()] = rawValue.replace(/^"|"$/g, "");
	}
	return values;
}

export async function readMultipartBody(
	request: IncomingMessage,
	contentType: string | string[],
): Promise<Record<string, unknown>> {
	const boundary = multipartBoundary(contentType);
	const raw = await readRawBody(request, 32 * 1024 * 1024);
	const binary = raw.toString("binary");
	const marker = `--${boundary}`;
	const attachments: WebUploadAttachment[] = [];
	const body: Record<string, unknown> = { text: "" };
	for (const section of binary.split(marker).slice(1)) {
		if (!section || section === "--\r\n" || section === "--") continue;
		const trimmed = section.replace(/^\r\n/, "").replace(/\r\n--$/, "");
		const headerEnd = trimmed.indexOf("\r\n\r\n");
		if (headerEnd < 0) continue;
		const headerText = trimmed.slice(0, headerEnd);
		let contentBinary = trimmed.slice(headerEnd + 4);
		if (contentBinary.endsWith("\r\n")) contentBinary = contentBinary.slice(0, -2);
		const headers = Object.fromEntries(
			headerText.split("\r\n").map((line) => {
				const colon = line.indexOf(":");
				return colon >= 0
					? [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]
					: [line.toLowerCase(), ""];
			}),
		);
		const disposition = parseContentDisposition(headers["content-disposition"] ?? "");
		const name = disposition.name;
		if (!name) continue;
		if (name === "text" || name === "channelKey" || name === "clientId") {
			body[name] = Buffer.from(contentBinary, "binary").toString("utf8");
			continue;
		}
		if (name !== "attachments") continue;
		const buffer = Buffer.from(contentBinary, "binary");
		if (buffer.length === 0) continue;
		attachments.push({
			name: disposition.filename,
			mimeType: headers["content-type"],
			size: buffer.length,
			buffer,
		});
	}
	body.attachments = attachments;
	return body;
}
