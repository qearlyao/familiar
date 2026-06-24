import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";

import type { Config } from "../src/config/index.js";
import type { EmbeddingInput, EmbeddingProvider } from "../src/memory/index/embedding-provider.js";
import type { MemoryRetrievalSearchOptions, MemoryRetrievalStore } from "../src/memory/index/retrieval.js";
import type { MemorySearchHit, StoredMemoryChunk } from "../src/memory/index/store.js";
import {
	MemoryService,
	type MemoryOperatorService,
	type MemoryServiceOptions,
} from "../src/memory/service.js";
import type { LcmRecordKind, LcmSourceProvenance, StoredLcmRecord } from "../src/memory/lcm/types.js";

export const testLcmSource: LcmSourceProvenance = {
	sourceType: "chat",
	sourceRef: "chat:test",
};

export class FakeEmbeddingProvider implements EmbeddingProvider {
	readonly api = "fake";
	readonly provider = "fake";
	readonly model = "fake-embedding";
	readonly dimensions: number;
	readonly batches: EmbeddingInput[][] = [];

	constructor(dimensions = 3) {
		this.dimensions = dimensions;
	}

	async embed(inputs: EmbeddingInput[], _signal?: AbortSignal): Promise<Float32Array[]> {
		this.batches.push(inputs);
		return inputs.map((input) => this.vectorFor(input));
	}

	async embedOne(input: EmbeddingInput, signal?: AbortSignal): Promise<Float32Array> {
		const [embedding] = await this.embed([input], signal);
		if (!embedding) throw new Error("missing embedding");
		return embedding;
	}

	private vectorFor(input: EmbeddingInput): Float32Array {
		const text = embeddingInputText(input);
		return new Float32Array(Array.from({ length: this.dimensions }, (_, index) => text.length + index));
	}
}

export class FakeRetrievalStore implements MemoryRetrievalStore {
	readonly lexicalCorpora: Array<string | undefined> = [];
	readonly semanticCorpora: Array<string | undefined> = [];

	constructor(
		private readonly lexicalHits: MemorySearchHit[],
		private readonly semanticHitsByCorpus: Map<string | undefined, MemorySearchHit[]>,
	) {}

	searchLexical(_query: string, options: number | MemoryRetrievalSearchOptions = {}): MemorySearchHit[] {
		const normalized = normalizeSearchOptions(options);
		this.lexicalCorpora.push(normalized.corpus);
		return this.lexicalHits
			.filter((hit) => !normalized.corpus || hit.chunk.corpus === normalized.corpus)
			.slice(0, normalized.limit);
	}

	searchSemantic(_query: Float32Array, options: number | MemoryRetrievalSearchOptions = {}): MemorySearchHit[] {
		const normalized = normalizeSearchOptions(options);
		this.semanticCorpora.push(normalized.corpus);
		return (this.semanticHitsByCorpus.get(normalized.corpus) ?? []).slice(0, normalized.limit);
	}
}

export function memoryHit(
	id: number,
	corpus: string,
	sourceId: string,
	text: string,
	score: number,
	metadata: Record<string, unknown> | null = null,
	createdAt = id,
): MemorySearchHit {
	return {
		id,
		score,
		chunk: memoryChunk(id, corpus, sourceId, text, metadata, createdAt),
	};
}

export function lcmRecord(
	id: number,
	kind: LcmRecordKind,
	text: string,
	happenedAt = `2026-05-10T00:${String(id).padStart(2, "0")}:00.000Z`,
): StoredLcmRecord {
	return {
		id,
		recordKey: `record-${id}`,
		segmentId: "seg-a",
		kind,
		text,
		parts: null,
		happenedAt,
		sessionId: "session-a",
		channelKey: "web-web-room",
		channelId: "room",
		jobId: null,
		source: testLcmSource,
		attachments: null,
		metadata: null,
		createdAt: id,
		updatedAt: id,
	};
}

export function assistantMessage(content: AssistantMessage["content"]): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: 2,
	};
}

export function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

export function contentText(message: unknown): string {
	if (!message) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text")
		.map((item) => item.text)
		.join("\n");
}

export function renderMessages(messages: unknown[]): string {
	return messages.map(contentText).join("\n");
}

export async function withMemoryService<T>(
	config: Config,
	run: (service: MemoryOperatorService) => Promise<T>,
): Promise<T>;
export async function withMemoryService<T>(
	config: Config,
	options: MemoryServiceOptions,
	run: (service: MemoryOperatorService) => Promise<T>,
): Promise<T>;
export async function withMemoryService<T>(
	config: Config,
	optionsOrRun: MemoryServiceOptions | ((service: MemoryOperatorService) => Promise<T>),
	run?: (service: MemoryOperatorService) => Promise<T>,
): Promise<T> {
	const options = typeof optionsOrRun === "function" ? undefined : optionsOrRun;
	const callback = typeof optionsOrRun === "function" ? optionsOrRun : run;
	if (!callback) throw new Error("missing memory service callback");
	const service = MemoryService.createWithoutRuntime(config, options);
	try {
		return await callback(service);
	} finally {
		service.close();
	}
}

function embeddingInputText(input: EmbeddingInput): string {
	if (typeof input === "string") return input;
	return input.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function memoryChunk(
	id: number,
	corpus: string,
	sourceId: string,
	text: string,
	metadata: Record<string, unknown> | null,
	createdAt: number,
): StoredMemoryChunk {
	return {
		id,
		contentHash: `hash-${id}`,
		corpus,
		sourceId,
		sourceRef: `ref-${sourceId}`,
		chunkIndex: 0,
		sources: [{ corpus, sourceId, sourceRef: `ref-${sourceId}`, chunkIndex: 0 }],
		text,
		snippet: text,
		tokenCount: null,
		metadata,
		embeddingModel: "fake",
		embeddingDimensions: 3,
		createdAt,
		updatedAt: id,
	};
}

function normalizeSearchOptions(options: number | MemoryRetrievalSearchOptions): { limit: number; corpus?: string } {
	if (typeof options === "number") return { limit: options };
	return { limit: options.limit ?? 10, corpus: options.corpus };
}
