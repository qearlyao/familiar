import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { AmbientDiaryInjector } from "../src/memory/diary/ambient-injector.js";
import { __memoryServiceTest } from "../src/memory/service.js";
import { retrieveAmbientDiary } from "../src/memory/diary/index.js";
import type { EmbeddingProvider } from "../src/memory/index/embedding-provider.js";
import type { MemorySearchHit } from "../src/memory/index/store.js";
import { FakeRetrievalStore as FakeStore, memoryHit } from "./memory-fakes.js";

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
		const messages: AgentMessage[] = [{ role: "user", content: " short ", timestamp: 0 }];

		const next = await injector.inject(messages, undefined, "session-a");

		assert.equal(next, messages);
		assert.deepEqual(provider.queries, []);
	});

	it("disabled ambient injection skips retrieval", async () => {
		const store = new FakeStore([hit(1, "diary_chunk", "day.md", "quiet memory", 0.1, {})], new Map());
		const provider = new FakeEmbeddingProviderFull();
		const injector = new AmbientDiaryInjector({
			store: store as any,
			embeddingProvider: provider,
			enabled: false,
			minQueryLength: 1,
			throttleSeconds: 0,
		});
		const messages: AgentMessage[] = [{ role: "user", content: "quiet memory please", timestamp: 0 }];

		const next = await injector.inject(messages, undefined, "session-a");

		assert.equal(next, messages);
		assert.deepEqual(provider.queries, []);
	});

	it("strips injected memory blocks from the next ambient query", async () => {
		const store = new FakeStore([], new Map());
		const provider = new FakeEmbeddingProviderFull();
		const injector = new AmbientDiaryInjector({
			store: store as any,
			embeddingProvider: provider,
			minQueryLength: 1,
			throttleSeconds: 0,
		});
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: "wait what did you see?\n\n<injected_memory>\n1. 2026-05-12: secret diary text\n</injected_memory>",
				timestamp: 0,
			},
		];

		await injector.inject(messages, undefined, "session-a");

		assert.deepEqual(provider.queries, ["wait what did you see?"]);
	});

	it("does not inject a diary when only a distant semantic nearest neighbor matched", async () => {
		const distant = hit(1, "diary_chunk", "day.md", "memory system sleep-deprived", 0.9, {});
		const store = new FakeStore([], new Map([["diary_chunk", [distant]]]));
		const provider = new FakeEmbeddingProviderFull();
		const injector = new AmbientDiaryInjector({
			store: store as any,
			embeddingProvider: provider,
			minQueryLength: 1,
			throttleSeconds: 0,
		});
		const messages: AgentMessage[] = [{ role: "user", content: "wait what did you see?", timestamp: 0 }];

		const next = await injector.inject(messages, undefined, "session-a");

		assert.equal(next, messages);
		assert.deepEqual(provider.queries, ["wait what did you see?"]);
	});

	it("does not let weak lexical matches bypass semantic relevance when embeddings are available", async () => {
		const distant = hit(1, "diary_chunk", "day.md", "Qearl gave me a memory system today", 0.9, {});
		const store = new FakeStore([distant], new Map([["diary_chunk", [distant]]]));
		const provider = new FakeEmbeddingProviderFull();
		const injector = new AmbientDiaryInjector({
			store: store as any,
			embeddingProvider: provider,
			minQueryLength: 1,
			throttleSeconds: 0,
		});
		const messages: AgentMessage[] = [{ role: "user", content: "what did you see today?", timestamp: 0 }];

		const next = await injector.inject(messages, undefined, "session-a");

		assert.equal(next, messages);
		assert.deepEqual(provider.queries, ["what did you see today?"]);
	});

	it("two ambient injections within throttle window skip the second call", async () => {
		let now = 1_000;
		const diary = hit(1, "diary_chunk", "day.md", "quiet memory", 0.1, {});
		const store = new FakeStore([diary], new Map([["diary_chunk", [diary]]]));
		const provider = new FakeEmbeddingProviderFull();
		const injector = new AmbientDiaryInjector({
			store: store as any,
			embeddingProvider: provider,
			minQueryLength: 1,
			throttleSeconds: 30,
			now: () => now,
		});
		const messages: AgentMessage[] = [{ role: "user", content: "quiet memory please", timestamp: 0 }];

		const first = await injector.inject(messages, undefined, "session-a");
		now += 10_000;
		const second = await injector.inject(messages, undefined, "session-a");

		assert.notEqual(first, messages);
		assert.equal(second, messages);
		assert.deepEqual(provider.queries, ["quiet memory please"]);
	});

	it("does not duplicate diary date and heading prefixes in injected memory", async () => {
		const text = __memoryServiceTest.renderAmbientDiaryRecall([
			ambientHit(
				hit(1, "diary_chunk", "2026-05-12.md", "quiet thread", 0.1, {
					date: "2026-05-12",
					heading: "2026-05-12",
				}),
				"2026-05-12 2026-05-12: quiet thread",
			),
		]);

		assert.match(text, /1\. 2026-05-12: quiet thread/);
		assert.doesNotMatch(text, /2026-05-12 2026-05-12/);
		assert.doesNotMatch(text, /2026-05-12: 2026-05-12/);
	});

	it("strips repeated prefixes from already-indexed ambient snippets", () => {
		assert.equal(
			__memoryServiceTest.stripRepeatedDiaryPrefix(
				"2026-05-12 2026-05-12: 2026-05-12 2026-05-12: Qearl gave me a memory system today.",
				["2026-05-12 2026-05-12", "2026-05-12"],
			),
			"Qearl gave me a memory system today.",
		);
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
	return memoryHit(id, corpus, sourceId, text, score, metadata, 1_775_779_200);
}

function ambientHit(base: MemorySearchHit, snippet: string): Awaited<ReturnType<typeof retrieveAmbientDiary>>[number] {
	return {
		...base,
		chunk: { ...base.chunk, snippet },
		lexicalRank: 1,
		semanticRank: null,
		lexicalScore: base.score,
		semanticScore: null,
		ambientScore: 1,
		boosts: {
			similarity: 1,
			valence: 0,
			intensity: 0,
			recency: 0,
		},
	};
}
