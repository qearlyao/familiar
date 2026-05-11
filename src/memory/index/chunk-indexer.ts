import type { EmbeddingInput, EmbeddingProvider } from "./embedding-provider.js";
import { createMemoryContentHash, type MemoryChunkInput, type MemoryIndexStore } from "./store.js";

export interface MemoryChunkIndexInput {
	corpus: string;
	sourceId?: string | null;
	sourceRef?: string | null;
	chunkIndex?: number;
	text: string;
	snippet?: string;
	tokenCount?: number | null;
	metadata?: Record<string, unknown> | null;
	embedding?: Float32Array;
}

export interface ChunkIndexerOptions {
	store: MemoryIndexStore;
	embeddingProvider: EmbeddingProvider;
}

export interface ChunkIndexResult {
	ids: number[];
	embedded: number;
	reused: number;
	skipped: number;
}

interface PreparedChunk {
	input: MemoryChunkIndexInput;
	text: string;
	chunkIndex: number;
	sourceId: string | null;
	contentHash: string;
	existingId: number | null;
	embedding?: Float32Array;
}

export class ChunkIndexer {
	private readonly store: MemoryIndexStore;
	private readonly embeddingProvider: EmbeddingProvider;

	constructor(options: ChunkIndexerOptions) {
		this.store = options.store;
		this.embeddingProvider = options.embeddingProvider;
	}

	async indexChunks(inputs: MemoryChunkIndexInput[], signal?: AbortSignal): Promise<ChunkIndexResult> {
		const prepared = this.prepare(inputs);
		if (prepared.length === 0) return { ids: [], embedded: 0, reused: 0, skipped: inputs.length };
		return this.insertPrepared(prepared, inputs.length - prepared.length, signal);
	}

	async replaceSource(
		corpus: string,
		sourceId: string,
		inputs: Omit<MemoryChunkIndexInput, "corpus" | "sourceId">[],
		signal?: AbortSignal,
	): Promise<ChunkIndexResult> {
		const prepared = this.prepare(inputs.map((input) => ({ ...input, corpus, sourceId })));
		const keepMappings = prepared.map((item) => ({ contentHash: item.contentHash, chunkIndex: item.chunkIndex }));
		this.store.deleteBySourceExceptMappings(corpus, sourceId, keepMappings);
		const result = await this.insertPrepared(prepared, inputs.length - prepared.length, signal);
		return result;
	}

	private prepare(inputs: MemoryChunkIndexInput[]): PreparedChunk[] {
		const embeddingConfig = this.store.embeddingConfig();

		const prepared: PreparedChunk[] = [];
		for (const input of inputs) {
			const text = input.text.trim();
			if (!text) continue;
			const chunkIndex = input.chunkIndex ?? 0;
			const sourceId = input.sourceId ?? null;
			prepared.push({
				input,
				text,
				chunkIndex,
				sourceId,
				contentHash: createMemoryContentHash({
					corpus: input.corpus,
					text,
					embeddingModel: embeddingConfig.model,
					embeddingDimensions: embeddingConfig.dimensions,
				}),
				existingId: null,
				embedding: input.embedding,
			});
		}
		return prepared;
	}

	private async insertPrepared(
		prepared: PreparedChunk[],
		skipped: number,
		signal?: AbortSignal,
	): Promise<ChunkIndexResult> {
		const startedAt = Date.now();
		if (prepared.length === 0) return { ids: [], embedded: 0, reused: 0, skipped };

		const present = this.store.whichHashesPresent(prepared.map((item) => item.contentHash));
		for (const item of prepared) item.existingId = present.get(item.contentHash) ?? null;

		const pendingEmbeddings = new Map<string, PreparedChunk>();
		const suppliedByHash = new Map<string, Float32Array>();
		for (const item of prepared) {
			if (item.embedding) {
				suppliedByHash.set(item.contentHash, item.embedding);
				pendingEmbeddings.delete(item.contentHash);
				continue;
			}
			if (
				item.existingId === null &&
				!pendingEmbeddings.has(item.contentHash) &&
				!suppliedByHash.has(item.contentHash)
			) {
				pendingEmbeddings.set(item.contentHash, item);
			}
		}

		const itemsToEmbed = [...pendingEmbeddings.values()];
		let embeddingCost = 0;
		const embeddings =
			itemsToEmbed.length === 0
				? []
				: await this.embeddingProvider.embed(
						itemsToEmbed.map((item): EmbeddingInput => {
							embeddingCost += item.text.length;
							return item.text;
						}),
						signal,
					);
		if (embeddings.length !== itemsToEmbed.length) {
			throw new Error(`Embedding count mismatch: expected ${itemsToEmbed.length}, got ${embeddings.length}`);
		}
		for (let index = 0; index < itemsToEmbed.length; index++) {
			const item = itemsToEmbed[index] as PreparedChunk;
			const embedding = embeddings[index];
			if (!embedding) throw new Error(`Embedding provider returned no result for chunk ${index}`);
			item.embedding = embedding;
		}

		const embeddedByHash = new Map(suppliedByHash);
		for (const item of itemsToEmbed) embeddedByHash.set(item.contentHash, item.embedding as Float32Array);

		const ids: number[] = new Array(prepared.length);
		const toInsert: MemoryChunkInput[] = [];
		const insertPositions: number[] = [];
		const existingMappings: MemoryChunkInput[] = [];
		for (let resultIndex = 0; resultIndex < prepared.length; resultIndex++) {
			const item = prepared[resultIndex] as PreparedChunk;
			if (item.existingId !== null) {
				ids[resultIndex] = item.existingId;
				existingMappings.push({
					corpus: item.input.corpus,
					sourceId: item.sourceId,
					sourceRef: item.input.sourceRef ?? null,
					chunkIndex: item.chunkIndex,
					text: item.text,
					snippet: item.input.snippet,
					tokenCount: item.input.tokenCount ?? null,
					metadata: item.input.metadata ?? null,
					embedding: item.embedding ?? new Float32Array(this.store.embeddingConfig().dimensions),
				});
				continue;
			}
			const embedding = item.embedding ?? embeddedByHash.get(item.contentHash);
			if (!embedding) throw new Error("Missing embedding for memory chunk");
			insertPositions.push(resultIndex);
			toInsert.push({
				corpus: item.input.corpus,
				sourceId: item.sourceId,
				sourceRef: item.input.sourceRef ?? null,
				chunkIndex: item.chunkIndex,
				text: item.text,
				snippet: item.input.snippet,
				tokenCount: item.input.tokenCount ?? null,
				metadata: item.input.metadata ?? null,
				embedding,
			});
		}

		this.store.recordSourceMappings(existingMappings);
		const insertedIds = this.store.insertChunks(toInsert);
		for (let index = 0; index < insertPositions.length; index++) {
			ids[insertPositions[index] as number] = insertedIds[index] as number;
		}

		const result = {
			ids,
			embedded: itemsToEmbed.length,
			reused: prepared.length - toInsert.length,
			skipped,
		};
		logMemoryIndexBatch({
			chunks: prepared.length,
			durationMs: Date.now() - startedAt,
			embeddingCost,
		});
		return result;
	}
}

function logMemoryIndexBatch(payload: { chunks: number; durationMs: number; embeddingCost: number }): void {
	if (process.env.DEBUG !== "memory-index") return;
	console.error(JSON.stringify({ event: "memory_index_batch", ...payload }));
}
