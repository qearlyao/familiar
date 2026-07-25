import { setTimeout as sleep } from "node:timers/promises";

import type { Config } from "../../config/index.js";

export type EmbeddingPart = { type: "text"; text: string } | { type: "inlineData"; mimeType: string; data: string };

export type EmbeddingInput = string | { parts: EmbeddingPart[] };

export interface EmbeddingProvider {
	readonly api: string;
	readonly provider: string;
	readonly model: string;
	readonly dimensions: number;
	embed(inputs: EmbeddingInput[], signal?: AbortSignal): Promise<Float32Array[]>;
	embedOne(input: EmbeddingInput, signal?: AbortSignal): Promise<Float32Array>;
}

export interface EmbeddingProviderOptions {
	fetchFn?: typeof fetch;
	sleepFn?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

interface GeminiEmbeddingResponse {
	embeddings?: Array<{
		values?: unknown;
	}>;
	embedding?: {
		values?: unknown;
	};
	error?: {
		message?: unknown;
	};
}

const MAX_EMBEDDING_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 60_000;

class EmbeddingHttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly headers: Headers,
	) {
		super(message);
	}
}

export function createEmbeddingProvider(config: Config, options: EmbeddingProviderOptions = {}): EmbeddingProvider {
	const format = config.memory.embedding.format;
	if (format === "gemini") {
		return new GeminiEmbeddingProvider(config, options.fetchFn ?? fetch, options.sleepFn ?? abortableSleep);
	}
	throw new Error(
		`NotImplementedError: memory.embedding.format=${format} is recognized but only gemini is implemented in v0`,
	);
}

class GeminiEmbeddingProvider implements EmbeddingProvider {
	readonly api = "gemini";
	readonly provider: string;
	readonly model: string;
	readonly dimensions: number;

	private readonly baseUrl: string;
	private readonly apiKeyEnv: string;
	private readonly batchSize: number;
	private readonly fetchFn: typeof fetch;
	private readonly sleepFn: (delayMs: number, signal?: AbortSignal) => Promise<void>;

	constructor(
		config: Config,
		fetchFn: typeof fetch,
		sleepFn: (delayMs: number, signal?: AbortSignal) => Promise<void>,
	) {
		this.provider = config.memory.embedding.provider;
		this.model = config.memory.embedding.model;
		this.dimensions = config.memory.embedding.dimensions;
		this.baseUrl = config.memory.embedding.baseUrl.replace(/\/+$/, "");
		this.apiKeyEnv = config.memory.embedding.apiKeyEnv;
		this.batchSize = config.memory.embedding.batchSize;
		if (this.batchSize < 1) throw new Error(`Embedding batch size must be >= 1, got ${this.batchSize}`);
		this.fetchFn = fetchFn;
		this.sleepFn = sleepFn;
	}

	async embedOne(input: EmbeddingInput, signal?: AbortSignal): Promise<Float32Array> {
		const [embedding] = await this.embed([input], signal);
		if (!embedding) throw new Error("Embedding provider returned no result");
		return embedding;
	}

	async embed(inputs: EmbeddingInput[], signal?: AbortSignal): Promise<Float32Array[]> {
		if (inputs.length === 0) return [];

		const embeddings: Float32Array[] = [];
		for (let index = 0; index < inputs.length; index += this.batchSize) {
			const chunk = inputs.slice(index, index + this.batchSize);
			embeddings.push(...(await this.embedBatch(chunk, signal)));
		}
		return embeddings;
	}

	private async embedBatch(inputs: EmbeddingInput[], signal?: AbortSignal): Promise<Float32Array[]> {
		const apiKey = this.apiKey();
		const url = new URL(this.buildUrl()).toString();
		for (let retry = 0; ; retry += 1) {
			signal?.throwIfAborted();
			try {
				const response = await this.fetchFn(url, {
					method: "POST",
					headers: this.buildHeaders(apiKey),
					body: JSON.stringify({
						requests: inputs.map((input) => ({
							model: this.modelResourceName(),
							content: { parts: embeddingInputParts(input) },
							outputDimensionality: this.dimensions,
						})),
					}),
					signal,
				});

				const { body, rawText } = await parseJsonResponse(response);
				if (!response.ok) {
					const message =
						typeof body.error?.message === "string"
							? body.error.message
							: truncate(rawText.trim() || response.statusText);
					throw new EmbeddingHttpError(
						`Embedding request failed: HTTP ${response.status} ${message}`.trim(),
						response.status,
						response.headers,
					);
				}

				const rawEmbeddings = Array.isArray(body.embeddings)
					? body.embeddings
					: body.embedding
						? [body.embedding]
						: [];
				if (rawEmbeddings.length !== inputs.length) {
					throw new Error(
						`Embedding response count mismatch: expected ${inputs.length}, got ${rawEmbeddings.length}`,
					);
				}
				return rawEmbeddings.map((embedding, index) => this.parseEmbeddingValues(embedding.values, index));
			} catch (error) {
				signal?.throwIfAborted();
				if (retry >= MAX_EMBEDDING_RETRIES || !isRetryableEmbeddingError(error)) throw error;
				const delayMs = retryDelayMs(error, retry);
				console.warn(
					`Embedding request failed transiently; retrying in ${delayMs}ms (${retry + 1}/${MAX_EMBEDDING_RETRIES}): ${errorMessage(error)}`,
				);
				await this.sleepFn(delayMs, signal);
			}
		}
	}

	private buildUrl(): string {
		return `${this.baseUrl}/${this.modelResourceName()}:batchEmbedContents`;
	}

	private buildHeaders(apiKey: string | undefined): HeadersInit {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (apiKey) headers["x-goog-api-key"] = apiKey;
		return headers;
	}

	private apiKey(): string | undefined {
		return this.apiKeyEnv ? process.env[this.apiKeyEnv] : undefined;
	}

	private modelResourceName(): string {
		return this.model.startsWith("models/") ? this.model : `models/${this.model}`;
	}

	private parseEmbeddingValues(values: unknown, index: number): Float32Array {
		if (!Array.isArray(values) || values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
			throw new Error(`Embedding response ${index} did not contain numeric values`);
		}
		if (values.length !== this.dimensions) {
			throw new Error(
				`Embedding dimension mismatch for result ${index}: expected ${this.dimensions}, got ${values.length}`,
			);
		}
		return new Float32Array(values);
	}
}

function embeddingInputParts(input: EmbeddingInput): GeminiPart[] {
	if (typeof input === "string") return [{ text: input }];
	return input.parts.map((part) => {
		if (part.type === "text") return { text: part.text };
		return { inlineData: { mimeType: part.mimeType, data: part.data } };
	});
}

async function parseJsonResponse(response: Response): Promise<{ body: GeminiEmbeddingResponse; rawText: string }> {
	const rawText = await response.text();
	if (!rawText.trim()) return { body: {}, rawText };
	try {
		return { body: JSON.parse(rawText) as GeminiEmbeddingResponse, rawText };
	} catch {
		return { body: {}, rawText };
	}
}

function truncate(text: string, maxLength = 300): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function isRetryableEmbeddingError(error: unknown): boolean {
	if (error instanceof EmbeddingHttpError) {
		return error.status === 408 || error.status >= 500;
	}
	if (!(error instanceof Error) || error.name === "AbortError") return false;
	return error instanceof TypeError || error.name === "TimeoutError";
}

function retryDelayMs(error: unknown, retry: number): number {
	if (!(error instanceof EmbeddingHttpError)) return 500 * 2 ** retry;
	const retryAfter = error.headers.get("retry-after");
	if (!retryAfter) return 500 * 2 ** retry;
	const seconds = Number.parseFloat(retryAfter);
	let delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
	if (Number.isNaN(delayMs)) return 500 * 2 ** retry;
	delayMs = Math.max(0, delayMs);
	if (delayMs > MAX_RETRY_DELAY_MS) {
		throw new Error(`Embedding retry delay ${Math.ceil(delayMs / 1000)}s exceeds 60s limit`, { cause: error });
	}
	return delayMs;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
	return sleep(delayMs, undefined, { signal });
}
