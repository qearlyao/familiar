import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

export const MAX_BODY_BYTES = 64 * 1024;

// Thrown where a request is malformed so the dispatcher can answer with the right
// client-error status instead of a blanket 500.
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}

/** Undefined for a bad host or an undecodable path; validated once here so handlers can decode freely. */
export function parseRequestUrl(request: IncomingMessage): URL | undefined {
	try {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		decodeURIComponent(url.pathname);
		return url;
	} catch {
		return undefined;
	}
}

export function createWebRequestListener(
	handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>,
): RequestListener {
	return (request, response) => {
		void (async () => {
			const url = parseRequestUrl(request);
			if (!url) throw new HttpError(400, "Malformed request URL");
			await handle(request, response, url);
		})().catch((error) => {
			const context = `Web request ${request.method} ${request.url?.split("?", 1)[0]}`;
			const status = error instanceof HttpError ? error.status : 500;
			if (status === 500) console.error(`${context} failed`, error);
			else console.warn(`${context} rejected: ${error.message}`);
			if (response.headersSent) response.destroy();
			else sendText(response, status, status === 500 ? "Internal server error" : error.message);
		});
	};
}

export function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): void {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...headers,
	});
	response.end(JSON.stringify(body));
}

export function sendText(response: ServerResponse, status: number, text: string): void {
	response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
	response.end(text);
}

export async function readJsonBody(
	request: AsyncIterable<Buffer | string>,
	maxBytes = MAX_BODY_BYTES,
): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > maxBytes) throw new HttpError(413, "Request body too large");
		chunks.push(buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		throw new HttpError(400, "Request body must be valid JSON");
	}
}
