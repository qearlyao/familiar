import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	retrieveMemory,
	type MemoryRetrievalSearchOptions,
	type MemoryRetrievalStore,
} from "../src/memory/index/retrieval.js";
import type { MemorySearchHit, StoredMemoryChunk } from "../src/memory/index/store.js";

class FakeStore implements MemoryRetrievalStore {
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

class FakeEmbeddingProvider {
	readonly queries: string[] = [];

	async embedOne(input: string, _signal?: AbortSignal): Promise<Float32Array> {
		this.queries.push(input);
		return new Float32Array([1, 0, 0]);
	}
}

class FailingEmbeddingProvider {
	async embedOne(_input: string, _signal?: AbortSignal): Promise<Float32Array> {
		throw new Error("embedding unavailable");
	}
}

describe("retrieveMemory", () => {
	it("merges lexical and semantic hits with stable rank scoring", async () => {
		const lantern = hit(1, "diary_chunk", "a", "blue lantern", 0.5);
		const index = hit(2, "lcm_record", "b", "database index", 0.1);
		const tangent = hit(3, "diary_chunk", "c", "quiet tangent", 0.2);
		const store = new FakeStore(
			[lantern, index],
			new Map([[undefined, [index, tangent]]]),
		);
		const provider = new FakeEmbeddingProvider();

		const results = await retrieveMemory({
			query: " lantern continuity ",
			store,
			embeddingProvider: provider,
			limit: 3,
		});

		assert.deepEqual(
			results.map((result) => result.id),
			[2, 1, 3],
		);
		assert.equal(results[0]?.lexicalRank, 2);
		assert.equal(results[0]?.semanticRank, 1);
		assert.equal(results[1]?.lexicalRank, 1);
		assert.equal(results[1]?.semanticRank, null);
		assert.deepEqual(provider.queries, ["lantern continuity"]);
		assert.deepEqual(store.lexicalCorpora, [undefined]);
		assert.deepEqual(store.semanticCorpora, [undefined]);
	});

	it("uses corpus-scoped semantic calls and filters lexical results to the same scope", async () => {
		const diary = hit(1, "diary_chunk", "day.md", "warm diary", 0.1);
		const lcm = hit(2, "lcm_record", "turn-1", "warm transcript", 0.01);
		const otherDiary = hit(3, "diary_chunk", "other.md", "other diary", 0.2);
		const store = new FakeStore(
			[lcm, diary, otherDiary],
			new Map([
				["diary_chunk", [otherDiary, diary]],
				["atomic_fact", [hit(4, "atomic_fact", "fact-1", "warm fact", 0.3)]],
			]),
		);

		const results = await retrieveMemory({
			query: "warm",
			store,
			embeddingProvider: new FakeEmbeddingProvider(),
			scope: { corpora: ["diary_chunk", "atomic_fact"], sourceIds: ["day.md", "fact-1"] },
			limit: 5,
		});

		assert.deepEqual(
			results.map((result) => [result.chunk.corpus, result.chunk.sourceId]),
			[
				["diary_chunk", "day.md"],
				["atomic_fact", "fact-1"],
			],
		);
		assert.deepEqual(store.lexicalCorpora, ["diary_chunk", "atomic_fact"]);
		assert.deepEqual(store.semanticCorpora, ["diary_chunk", "atomic_fact"]);
	});

	it("ranks RRF hits per corpus so corpus fan-out order does not change ranking", async () => {
		const a = hit(1, "corpus_a", "a", "same quality a", 0.1);
		const b = hit(2, "corpus_b", "b", "same quality b", 0.1);
		const firstStore = new FakeStore(
			[a, b],
			new Map([
				["corpus_a", [a]],
				["corpus_b", [b]],
			]),
		);
		const secondStore = new FakeStore(
			[b, a],
			new Map([
				["corpus_a", [a]],
				["corpus_b", [b]],
			]),
		);

		const first = await retrieveMemory({
			query: "same quality",
			store: firstStore,
			embeddingProvider: new FakeEmbeddingProvider(),
			scope: { corpora: ["corpus_a", "corpus_b"] },
			limit: 2,
		});
		const second = await retrieveMemory({
			query: "same quality",
			store: secondStore,
			embeddingProvider: new FakeEmbeddingProvider(),
			scope: { corpora: ["corpus_b", "corpus_a"] },
			limit: 2,
		});

		assert.deepEqual(first.map((result) => result.id), second.map((result) => result.id));
		assert.deepEqual(
			first.map((result) => result.lexicalRank),
			[1, 1],
		);
	});

	it("filters hits by metadata timestamp or chunk creation time", async () => {
		const early = hit(1, "lcm_record", "early", "timeline marker", 0.1, {
			timestamp: "2026-05-10T01:00:00.000Z",
		});
		const middle = hit(2, "lcm_record", "middle", "timeline marker", 0.1, {
			timestamp: "2026-05-10T02:00:00.000Z",
		});
		const late = hit(3, "lcm_record", "late", "timeline marker", 0.1, null, Date.parse("2026-05-10T03:00:00.000Z"));
		const store = new FakeStore([early, middle, late], new Map());

		const results = await retrieveMemory({
			query: "timeline",
			store,
			embeddingProvider: null,
			useSemantic: false,
			scope: {
				corpora: ["lcm_record"],
				after: "2026-05-10T01:30:00.000Z",
				before: "2026-05-10T02:30:00.000Z",
			},
			limit: 5,
		});

		assert.deepEqual(
			results.map((result) => result.id),
			[2],
		);
	});

	it("filters LCM hits by happenedAt and summary coverage metadata before createdAt", async () => {
		const record = hit(
			1,
			"lcm_record",
			"record",
			"timeline marker",
			0.1,
			{ happenedAt: "2026-05-10T02:00:00.000Z" },
			Date.parse("2026-05-12T00:00:00.000Z"),
		);
		const summary = hit(
			2,
			"lcm_summary",
			"summary",
			"timeline marker",
			0.1,
			{ coverageToHappenedAt: "2026-05-10T02:05:00.000Z" },
			Date.parse("2026-05-12T00:00:00.000Z"),
		);
		const createdAtOnly = hit(3, "lcm_record", "created", "timeline marker", 0.1, null, Date.parse("2026-05-12T00:00:00.000Z"));
		const store = new FakeStore([record, summary, createdAtOnly], new Map());

		const results = await retrieveMemory({
			query: "timeline",
			store,
			embeddingProvider: null,
			useSemantic: false,
			scope: {
				corpora: ["lcm_record", "lcm_summary"],
				after: "2026-05-10T01:30:00.000Z",
				before: "2026-05-10T02:30:00.000Z",
			},
			limit: 5,
		});

		assert.deepEqual(
			results.map((result) => result.id),
			[1, 2],
		);
	});

	it("can run lexical-only without embedding a query", async () => {
		const lexical = hit(1, "lcm_summary", "summary-1", "migration summary", -1.2);
		const store = new FakeStore([lexical], new Map([[undefined, [hit(2, "lcm_summary", "summary-2", "semantic", 0.1)]]]));
		const provider = new FakeEmbeddingProvider();

		const results = await retrieveMemory({
			query: "migration",
			store,
			embeddingProvider: provider,
			useSemantic: false,
		});

		assert.deepEqual(
			results.map((result) => result.id),
			[1],
		);
		assert.deepEqual(provider.queries, []);
		assert.deepEqual(store.lexicalCorpora, [undefined]);
		assert.deepEqual(store.semanticCorpora, []);
	});

	it("falls back to lexical hits when semantic embedding fails", async () => {
		const lexical = hit(1, "lcm_summary", "summary-1", "migration summary", -1.2);
		const store = new FakeStore([lexical], new Map([[undefined, [hit(2, "lcm_summary", "summary-2", "semantic", 0.1)]]]));

		const results = await retrieveMemory({
			query: "migration",
			store,
			embeddingProvider: new FailingEmbeddingProvider(),
		});

		assert.deepEqual(
			results.map((result) => result.id),
			[1],
		);
		assert.deepEqual(store.lexicalCorpora, [undefined]);
		assert.deepEqual(store.semanticCorpora, []);
	});

	it("returns no hits for empty queries", async () => {
		const store = new FakeStore([hit(1, "diary_chunk", "a", "unused", 0)], new Map());
		const provider = new FakeEmbeddingProvider();

		const results = await retrieveMemory({ query: "  ", store, embeddingProvider: provider });

		assert.deepEqual(results, []);
		assert.deepEqual(provider.queries, []);
	});
});

function hit(
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
		chunk: chunk(id, corpus, sourceId, text, metadata, createdAt),
	};
}

function chunk(
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
	return options.corpus ? { limit: options.limit ?? 10, corpus: options.corpus } : { limit: options.limit ?? 10 };
}
