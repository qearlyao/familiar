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

export function createEmbeddingProvider(config: Config, options: EmbeddingProviderOptions = {}): EmbeddingProvider {
	const format = config.memory.embedding.format ?? config.memory.embedding.api;
	if (format === "gemini") return new GeminiEmbeddingProvider(config, options.fetchFn ?? fetch);
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

	constructor(config: Config, fetchFn: typeof fetch) {
		this.provider = config.memory.embedding.provider;
		this.model = config.memory.embedding.model;
		this.dimensions = config.memory.embedding.dimensions;
		this.baseUrl = config.memory.embedding.baseUrl.replace(/\/+$/, "");
		this.apiKeyEnv = config.memory.embedding.apiKeyEnv;
		this.batchSize = config.memory.embedding.batchSize;
		if (this.batchSize < 1) throw new Error(`Embedding batch size must be >= 1, got ${this.batchSize}`);
		this.fetchFn = fetchFn;
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
			// Sequential batches are gentle on hosted rate limits; add bounded
			// concurrency later if indexing throughput becomes a bottleneck.
			embeddings.push(...(await this.embedBatch(chunk, signal)));
		}
		return embeddings;
	}

	private async embedBatch(inputs: EmbeddingInput[], signal?: AbortSignal): Promise<Float32Array[]> {
		const apiKey = this.apiKey();
		const response = await this.fetchFn(this.buildUrl(), {
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
			throw new Error(`Embedding request failed: HTTP ${response.status} ${message}`.trim());
		}

		const rawEmbeddings = Array.isArray(body.embeddings) ? body.embeddings : body.embedding ? [body.embedding] : [];
		if (rawEmbeddings.length !== inputs.length) {
			throw new Error(`Embedding response count mismatch: expected ${inputs.length}, got ${rawEmbeddings.length}`);
		}
		return rawEmbeddings.map((embedding, index) => this.parseEmbeddingValues(embedding.values, index));
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
