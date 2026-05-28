import { fetchJson, fetchText } from "./http.js";
import { FETCH_TIMEOUT_MS, type FetchProvider, MAX_RESPONSE_BYTES, ProviderError } from "./types.js";
import { isPlainObject } from "./util.js";

export function createJinaProvider(apiKey?: string | null): FetchProvider {
	return {
		name: "jina",
		async fetch(url: string, signal: AbortSignal): Promise<string> {
			const target = `https://r.jina.ai/${url}`;
			const headers = buildJinaHeaders(apiKey, "application/json");
			try {
				const jsonContent = await fetchJinaContent(target, headers, signal, true);
				if (jsonContent) return jsonContent;
			} catch (error) {
				if (!shouldFallbackToText(error)) {
					throw error;
				}
			}
			const textContent = await fetchJinaContent(target, buildJinaHeaders(apiKey, "text/plain"), signal, false);
			if (textContent) return textContent;
			throw new ProviderError("jina", "jina returned an empty response.", false);
		},
	};
}

export function createTinyfishProvider(apiKey: string): FetchProvider {
	const trimmed = apiKey.trim();
	return {
		name: "tinyfish",
		async fetch(url: string, signal: AbortSignal): Promise<string> {
			const response = await fetchJson<{ content: string }>("tinyfish", "https://api.fetch.tinyfish.ai", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-API-Key": trimmed,
				},
				body: JSON.stringify({
					urls: [url],
					format: "markdown",
				}),
				signal,
				timeoutMs: FETCH_TIMEOUT_MS,
				maxBytes: MAX_RESPONSE_BYTES.fetch,
				validate: parseTinyfishResponse,
			});
			return response.content;
		},
	};
}

export function parseTinyfishResponse(value: unknown): { content: string } {
	if (!isPlainObject(value)) {
		throw new ProviderError("tinyfish", "TinyFish returned unexpected response shape.", false);
	}

	const results = value.results;
	if (Array.isArray(results)) {
		const first = results[0];
		if (isPlainObject(first)) {
			const content =
				typeof first.content === "string"
					? first.content
					: typeof first.markdown === "string"
						? first.markdown
						: typeof first.text === "string"
							? first.text
							: "";
			if (content.trim()) return { content: content.replaceAll(/\r\n/g, "\n").trim() };
		}
	}

	const errors = Array.isArray(value.errors) ? value.errors : undefined;
	const firstError = errors?.find((entry) => isPlainObject(entry));
	if (isPlainObject(firstError)) {
		const message =
			typeof firstError.message === "string"
				? firstError.message
				: typeof firstError.error === "string"
					? firstError.error
					: "TinyFish failed to fetch the page.";
		throw new ProviderError("tinyfish", message, false);
	}

	throw new ProviderError("tinyfish", "TinyFish returned no page content.", false);
}

export function buildJinaHeaders(apiKey: string | null | undefined, accept: string): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: accept,
		"X-Retain-Images": "none",
	};
	if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
	return headers;
}

export async function fetchJinaContent(
	targetUrl: string,
	headers: Record<string, string>,
	signal: AbortSignal,
	preferJson: boolean,
): Promise<string | undefined> {
	const responseText = await fetchText("jina", targetUrl, {
		headers,
		signal,
		timeoutMs: FETCH_TIMEOUT_MS,
		maxBytes: MAX_RESPONSE_BYTES.fetch,
	});
	if (preferJson) {
		try {
			const parsed = JSON.parse(responseText) as unknown;
			if (isPlainObject(parsed) && isPlainObject(parsed.data)) {
				if (typeof parsed.data.content === "string" && parsed.data.content.trim()) {
					return parsed.data.content.replaceAll(/\r\n/g, "\n").trim();
				}
				if (typeof parsed.data.markdown === "string" && parsed.data.markdown.trim()) {
					return parsed.data.markdown.replaceAll(/\r\n/g, "\n").trim();
				}
			}
		} catch {
			return undefined;
		}
		return undefined;
	}
	return responseText.replaceAll(/\r\n/g, "\n").trim() || undefined;
}

export function shouldFallbackToText(error: unknown): boolean {
	return error instanceof ProviderError && (error.status === 406 || error.status === 415);
}
