import { type FetchProviderName, ProviderError, type ProviderName } from "./types.js";

export function buildRequestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

export async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let totalBytes = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			throw new Error(`Response exceeded size limit of ${maxBytes} bytes.`);
		}
		chunks.push(decoder.decode(value, { stream: true }));
	}

	chunks.push(decoder.decode());
	return chunks.join("");
}

export function createHttpError(provider: ProviderName, response: Response): ProviderError {
	return new ProviderError(
		provider,
		`${provider} request failed: ${response.status} ${response.statusText}`.trim(),
		response.status >= 500 || response.status === 408 || response.status === 429,
		response.status,
	);
}

export async function fetchJson<T>(
	provider: ProviderName,
	url: string,
	options: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal: AbortSignal;
		timeoutMs: number;
		maxBytes: number;
		validate: (value: unknown) => T;
	},
): Promise<T> {
	try {
		const response = await fetch(url, {
			method: options.method ?? "GET",
			headers: options.headers,
			body: options.body,
			redirect: "error",
			signal: buildRequestSignal(options.signal, options.timeoutMs),
		});
		if (!response.ok) throw createHttpError(provider, response);
		const body = await readBoundedBody(response, options.maxBytes);
		const parsed = body ? JSON.parse(body) : null;
		return options.validate(parsed);
	} catch (error) {
		if (error instanceof ProviderError) throw error;
		if (options.signal.aborted) throw error;
		throw new ProviderError(
			provider,
			error instanceof Error ? `${provider} request failed: ${error.message}` : `${provider} request failed.`,
			true,
			undefined,
			error,
		);
	}
}

export async function fetchText(
	provider: FetchProviderName,
	url: string,
	options: {
		headers?: Record<string, string>;
		signal: AbortSignal;
		timeoutMs: number;
		maxBytes: number;
	},
): Promise<string> {
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: options.headers,
			redirect: "error",
			signal: buildRequestSignal(options.signal, options.timeoutMs),
		});
		if (!response.ok) throw createHttpError(provider, response);
		return await readBoundedBody(response, options.maxBytes);
	} catch (error) {
		if (error instanceof ProviderError) throw error;
		if (options.signal.aborted) throw error;
		throw new ProviderError(
			provider,
			error instanceof Error ? `${provider} request failed: ${error.message}` : `${provider} request failed.`,
			true,
			undefined,
			error,
		);
	}
}
