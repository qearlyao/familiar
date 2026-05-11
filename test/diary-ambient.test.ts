import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { AmbientDiaryInjector } from "../src/memory/diary/ambient-injector.js";
import { retrieveAmbientDiary } from "../src/memory/diary/index.js";
import type { EmbeddingProvider } from "../src/memory/index/embedding-provider.js";
import {
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

	async embedOne(input: string): Promise<Float32Array> {
		this.queries.push(input);
		return new Float32Array([1, 0, 0]);
	}
}

class FakeEmbeddingProviderFull extends FakeEmbeddingProvider implements EmbeddingProvider {
	readonly api = "fake";
	readonly provider = "fake";
	readonly model = "fake";
	readonly dimensions = 3;

	async embed(inputs: string[]): Promise<Float32Array[]> {
		return Promise.all(inputs.map((input) => this.embedOne(input)));
	}
}

describe("ambient diary retrieval", () => {
	it("calls retrieveMemory diary-first and reranks with metadata boosts", async () => {
		const oldClose = hit(1, "diary_chunk", "2025-12-01.md", "lantern old", 0.01, {
			date: "2025-12-01",
			valence: 0,
			intensity: 0,
		});
		const recentFelt = hit(2, "diary_chunk", "2026-05-09.md", "lantern recent", 0.02, {
			date: "2026-05-09",
			valence: 0.5,
			intensity: 0.5,
		});
		const factual = hit(3, "lcm_record", "turn-1", "lantern factual", 0.001, {});
		const store = new FakeStore(
			[factual, oldClose, recentFelt],
			new Map([["diary_chunk", [oldClose, recentFelt]]]),
		);
		const provider = new FakeEmbeddingProvider();

		const results = await retrieveAmbientDiary({
			query: " lantern ",
			store,
			embeddingProvider: provider,
			limit: 2,
			now: new Date("2026-05-10T00:00:00.000Z"),
			metadataBoosts: { valence: 0.4, intensity: 0.4, recency: 0.4 },
		});

		assert.deepEqual(provider.queries, ["lantern"]);
		assert.deepEqual(store.lexicalCorpora, ["diary_chunk"]);
		assert.deepEqual(store.semanticCorpora, ["diary_chunk"]);
		assert.deepEqual(
			results.map((result) => result.id),
			[2, 1],
		);
		assert.ok((results[0]?.boosts.valence ?? 0) > 0);
		assert.ok((results[0]?.boosts.recency ?? 0) > (results[1]?.boosts.recency ?? 1));
		assert.equal(results.some((result) => result.chunk.corpus === "lcm_record"), false);
	});

	it("returns structured hits without rendering policy", async () => {
		const diary = hit(1, "diary_chunk", "2026-05-10.md", "quiet continuity", 0.1, {
			date: "2026-05-10",
			heading: "Evening",
			valence: "0.5",
			intensity: "7",
		});
		const store = new FakeStore([diary], new Map());

		const [result] = await retrieveAmbientDiary({
			query: "quiet",
			store,
			limit: 1,
			useSemantic: false,
			now: new Date("2026-05-10T12:00:00.000Z"),
		});

		assert.equal(result?.chunk.metadata?.heading, "Evening");
		assert.equal(typeof result?.chunk.text, "string");
		assert.equal(typeof result?.ambientScore, "number");
		assert.deepEqual(store.semanticCorpora, []);
	});

	it("short query below min skips ambient injection", async () => {
		const store = new FakeStore([hit(1, "diary_chunk", "day.md", "quiet memory", 0.5, {})], new Map());
		const provider = new FakeEmbeddingProviderFull();
		const injector = new AmbientDiaryInjector({
			store: store as any,
			embeddingProvider: provider,
			minQueryLength: 8,
			throttleSeconds: 0,
		});
		const messages: AgentMessage[] = [{ role: "user", content: " short " }];

		const next = await injector.inject(messages, undefined, "session-a");

		assert.equal(next, messages);
		assert.deepEqual(provider.queries, []);
	});

	it("two ambient injections within throttle window skip the second call", async () => {
		let now = 1_000;
		const diary = hit(1, "diary_chunk", "day.md", "quiet memory", 0.5, {});
		const store = new FakeStore([diary], new Map([["diary_chunk", [diary]]]));
		const provider = new FakeEmbeddingProviderFull();
		const injector = new AmbientDiaryInjector({
			store: store as any,
			embeddingProvider: provider,
			minQueryLength: 1,
			throttleSeconds: 30,
			now: () => now,
		});
		const messages: AgentMessage[] = [{ role: "user", content: "quiet memory please" }];

		const first = await injector.inject(messages, undefined, "session-a");
		now += 10_000;
		const second = await injector.inject(messages, undefined, "session-a");

		assert.notEqual(first, messages);
		assert.equal(second, messages);
		assert.deepEqual(provider.queries, ["quiet memory please"]);
	});

	it("weight knobs influence final ordering", async () => {
		const similar = hit(1, "diary_chunk", "old.md", "similar old", 0.01, {
			date: "2025-01-01",
			valence: 0,
			intensity: 0,
		});
		const intense = hit(2, "diary_chunk", "new.md", "intense new", 0.02, {
			date: "2025-01-01",
			valence: 1,
			intensity: 1,
		});
		const store = new FakeStore([], new Map([["diary_chunk", [similar, intense]]]));

		const defaultOrder = await retrieveAmbientDiary({
			query: "memory",
			store,
			embeddingProvider: new FakeEmbeddingProvider(),
			limit: 2,
			now: new Date("2026-05-10T00:00:00.000Z"),
			useLexical: false,
			weights: { similarity: 1, valence: 0, intensity: 0, recency: 0 },
		});
		const boostedOrder = await retrieveAmbientDiary({
			query: "memory",
			store,
			embeddingProvider: new FakeEmbeddingProvider(),
			limit: 2,
			now: new Date("2026-05-10T00:00:00.000Z"),
			useLexical: false,
			weights: { similarity: 0.1, valence: 1, intensity: 1, recency: 1 },
		});

		assert.deepEqual(defaultOrder.map((result) => result.id), [1, 2]);
		assert.deepEqual(boostedOrder.map((result) => result.id), [2, 1]);
	});
});

function hit(
	id: number,
	corpus: string,
	sourceId: string,
	text: string,
	score: number,
	metadata: Record<string, unknown>,
): MemorySearchHit {
	return {
		id,
		score,
		chunk: {
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
			createdAt: 1_775_779_200,
			updatedAt: 1_775_779_200,
		} satisfies StoredMemoryChunk,
	};
}

function normalizeSearchOptions(options: number | MemoryRetrievalSearchOptions): { limit: number; corpus?: string } {
	if (typeof options === "number") return { limit: options };
	return options.corpus ? { limit: options.limit ?? 10, corpus: options.corpus } : { limit: options.limit ?? 10 };
}
