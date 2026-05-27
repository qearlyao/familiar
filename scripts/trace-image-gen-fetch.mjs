import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const enabled = process.env.FAMILIAR_IMAGE_GEN_TRACE === "1";
const originalFetch = globalThis.fetch?.bind(globalThis);

function tracePath(now = new Date()) {
	const date = now.toISOString().slice(0, 10);
	return resolve(
		process.env.FAMILIAR_IMAGE_GEN_TRACE_DIR || resolve(homedir(), ".familiar", "data", "image-gen-trace"),
		`${date}.jsonl`,
	);
}

function headersRecord(headers) {
	if (!headers) return {};
	if (headers instanceof Headers) return Object.fromEntries(headers.entries());
	if (Array.isArray(headers)) return Object.fromEntries(headers);
	return { ...headers };
}

function redactedHeaders(headers) {
	const record = headersRecord(headers);
	for (const key of Object.keys(record)) {
		if (key.toLowerCase() === "authorization") record[key] = "[redacted]";
	}
	return record;
}

function requestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input?.url ? String(input.url) : "";
}

function bodyText(init) {
	if (typeof init?.body === "string") return init.body;
	if (init?.body instanceof Uint8Array) return Buffer.from(init.body).toString("utf8");
	return undefined;
}

function parseJson(text) {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function containsImageGenerationRequest(url, payload) {
	if (!url.includes("/chat/completions") || !payload || typeof payload !== "object") return false;
	const record = payload;
	if (Array.isArray(record.modalities) && record.modalities.includes("image")) return true;
	return JSON.stringify(record).includes('"image_url"');
}

function requestSummary(payload) {
	if (!payload || typeof payload !== "object") return undefined;
	return {
		model: payload.model,
		modalities: payload.modalities,
		messageCount: Array.isArray(payload.messages) ? payload.messages.length : undefined,
	};
}

async function writeTrace(record) {
	const path = tracePath();
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

if (enabled && originalFetch) {
	globalThis.fetch = async (input, init) => {
		const startedAt = Date.now();
		const url = requestUrl(input);
		const requestBodyText = bodyText(init);
		const requestPayload = parseJson(requestBodyText);
		const shouldTrace = containsImageGenerationRequest(url, requestPayload);
		const response = await originalFetch(input, init);

		if (shouldTrace) {
			void response
				.clone()
				.text()
				.then((rawBody) =>
					writeTrace({
						ts: new Date().toISOString(),
						durationMs: Date.now() - startedAt,
						request: {
							url,
							method: init?.method || "GET",
							headers: redactedHeaders(init?.headers),
							summary: requestSummary(requestPayload),
						},
						response: {
							status: response.status,
							statusText: response.statusText,
							headers: headersRecord(response.headers),
							rawBody,
							json: parseJson(rawBody),
						},
					}),
				)
				.catch((error) => console.error("image generation trace write failed", error));
		}

		return response;
	};
}
