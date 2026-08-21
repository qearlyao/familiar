import type { AssistantImages, ImagesContext, ImagesModel, ImagesOptions } from "@earendil-works/pi-ai/compat";

import { sniffImageMimeType } from "../../util/image-mime.js";

/** Response bodies are echoed into error messages up to this many characters. */
const MAX_ERROR_BODY_CHARS = 500;

/** Ceiling on a single decoded image, matching the inbound attachment budget. */
export const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Ceiling on images taken from one response. Extra entries are ignored rather
 * than treated as an error, so an over-eager provider still yields a picture.
 */
export const MAX_GENERATED_IMAGES = 10;

export interface ImageRequestContext {
	prompt: string;
	references: { mimeType: string; data: string }[];
}

/**
 * Append `defaultPath` only when the configured base URL has no path of its
 * own. `https://api.openai.com` gains `/v1`; `http://gateway.internal/openai/v1`
 * is left exactly as written, which is what self-hosted gateways need.
 */
export function withDefaultPath(baseUrl: string, defaultPath: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	// An unparseable base URL is a config error; surfacing it here names the
	// setting instead of failing later as an opaque fetch error.
	const parsed = new URL(trimmed);
	// Keep the URL as written when it carries its own path, so any query the
	// gateway signs into the base URL survives.
	return parsed.pathname === "/" ? `${parsed.origin}${defaultPath}` : trimmed;
}

/** Split an ImagesContext into the prompt text and the reference images. */
export function imageRequestContext(context: ImagesContext): ImageRequestContext {
	const texts: string[] = [];
	const references: { mimeType: string; data: string }[] = [];
	for (const item of context.input) {
		if (item.type === "text") texts.push(item.text);
		else references.push({ mimeType: item.mimeType, data: item.data });
	}
	return { prompt: texts.join("\n"), references };
}

export function apiKeyOrThrow(model: ImagesModel<string>, options: ImagesOptions | undefined): string {
	const apiKey = options?.apiKey;
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	return apiKey;
}

/**
 * Compose the caller's abort signal with the configured timeout. Returns
 * undefined when neither is set so `fetch` is left alone.
 */
export function requestSignal(options: ImagesOptions | undefined): AbortSignal | undefined {
	const timeoutMs = options?.timeoutMs;
	if (timeoutMs === undefined) return options?.signal;
	const timeout = AbortSignal.timeout(timeoutMs);
	return options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

/** Read a response body for error reporting, bounded and never throwing. */
async function errorBody(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	const trimmed = text.trim();
	if (!trimmed) return "";
	return trimmed.length > MAX_ERROR_BODY_CHARS ? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}…` : trimmed;
}

/**
 * Check status before reading the body: an HTTP failure is classified by
 * status even when the body breaks mid-read, which would otherwise surface as
 * a misleading JSON parse error.
 */
export async function assertOk(response: Response, url: string): Promise<void> {
	if (response.ok) return;
	const body = await errorBody(response);
	throw new Error(`${response.status} ${response.statusText} from ${url}${body ? `: ${body}` : ""}`);
}

export async function readJson(response: Response, url: string): Promise<unknown> {
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		const contentType = response.headers.get("content-type") ?? "unknown";
		const snippet = text.trim().slice(0, MAX_ERROR_BODY_CHARS);
		throw new Error(`Expected JSON from ${url} but received ${contentType}: ${snippet}`);
	}
}

/**
 * Turn a base64 payload into image output, sniffing the real MIME type from
 * the bytes so a provider's mislabeled `image/png` does not produce a file
 * with the wrong extension.
 */
export function imageFromBase64(data: string, declaredMimeType?: string): AssistantImages["output"][number] {
	const trimmed = data.trim();
	const buffer = Buffer.from(trimmed, "base64");
	if (!buffer.length) throw new Error("Provider returned an empty image payload");
	if (buffer.byteLength > MAX_GENERATED_IMAGE_BYTES) {
		throw new Error(`Provider returned an image over ${MAX_GENERATED_IMAGE_BYTES} bytes`);
	}
	const mimeType = sniffImageMimeType(buffer) ?? declaredMimeType;
	if (!mimeType) throw new Error("Provider returned data that is not a recognizable image");
	return { type: "image", mimeType, data: trimmed };
}

/** Fetch a provider-hosted image URL and inline it as base64. */
export async function imageFromUrl(
	url: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal | undefined,
): Promise<AssistantImages["output"][number]> {
	const response = await fetchImpl(url, { ...(signal ? { signal } : {}) });
	await assertOk(response, url);
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.byteLength > MAX_GENERATED_IMAGE_BYTES) {
		throw new Error(`Provider image at ${url} is over ${MAX_GENERATED_IMAGE_BYTES} bytes`);
	}
	const mimeType = sniffImageMimeType(buffer);
	if (!mimeType) throw new Error(`Provider image at ${url} is not a recognizable image`);
	return { type: "image", mimeType, data: buffer.toString("base64") };
}

/**
 * Run an adapter body and map thrown errors onto the AssistantImages error
 * shape, matching how pi-ai's own image adapters report failure.
 */
export async function runImageRequest(
	model: ImagesModel<string>,
	options: ImagesOptions | undefined,
	run: (fetchImpl: typeof fetch, signal: AbortSignal | undefined) => Promise<AssistantImages["output"]>,
): Promise<AssistantImages> {
	const base: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const signal = requestSignal(options);
	try {
		const fetchImpl = (options?.fetch ?? globalThis.fetch) as typeof fetch;
		const output = await run(fetchImpl, signal);
		return { ...base, output };
	} catch (error) {
		return {
			...base,
			stopReason: options?.signal?.aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Merge our own headers with the model's and the caller's, later sources
 * winning. A null value suppresses the header entirely, matching how pi-ai's
 * ProviderHeaders behaves elsewhere. Names are lowercased so a `Content-Type`
 * from one source and a `content-type` from another cannot both survive.
 */
export function headersFor(
	model: ImagesModel<string>,
	options: ImagesOptions | undefined,
	own: Record<string, string>,
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const source of [own, model.headers, options?.headers]) {
		for (const [name, value] of Object.entries(source ?? {})) {
			const key = name.toLowerCase();
			if (value === null) delete headers[key];
			else headers[key] = value;
		}
	}
	return headers;
}
