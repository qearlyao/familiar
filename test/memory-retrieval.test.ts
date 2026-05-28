import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { retrieveMemory } from "../src/memory/index/retrieval.js";
import { FakeRetrievalStore as FakeStore, memoryHit as hit } from "./memory-fakes.js";


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

	it("deduplicates repeated visible memories across runtime and backfill sources", async () => {
		const runtime = hit(1, "lcm_record", "runtime", "yeah, stargazy pie. looks cursed.", 0.01, {
			kind: "assistant",
			timestamp: "2026-05-09T05:07:22.811Z",
			source: { sourceRef: "runtime:abc" },
		});
		const backfill = hit(2, "lcm_record", "backfill", "yeah, stargazy pie. looks cursed.", 0.02, {
			kind: "assistant",
			timestamp: "2026-05-09T05:07:28.805Z",
			source: { sourceRef: "chat/file.jsonl#1439" },
		});
		const doubledBackfill = hit(
			3,
			"lcm_record",
			"doubled",
			"fish pie, you mean? looks cursed.fish pie, you mean? looks cursed.",
			0.03,
		);
		const cleanRuntime = hit(4, "lcm_record", "clean-runtime", "fish pie, you mean? looks cursed.", 0.04);
		const store = new FakeStore([runtime, backfill, doubledBackfill, cleanRuntime], new Map());

		const results = await retrieveMemory({
			query: "stargazy pie",
			store,
			embeddingProvider: null,
			useSemantic: false,
			scope: { corpora: ["lcm_record"] },
			limit: 8,
		});

		assert.deepEqual(
			results.map((result) => result.id),
			[1, 3],
		);
	});

	it("deduplicates cross-source memories by message id and rounded turn identity", async () => {
		const runtimeUser = hit(1, "lcm_record", "runtime-user", "[user] noooo, it's called Stargazy pie", 0.01, {
			kind: "user",
			timestamp: "2026-05-09T05:07:22.811Z",
			source: { sourceRef: "runtime:abc" },
		});
		const backfillUser = hit(2, "lcm_record", "backfill-user", "noooo, it's called Stargazy pie", 0.02, {
			kind: "user",
			timestamp: "2026-05-09T05:07:22.802Z",
			source: {
				sourceMessageId: "user_bc998055-f743-4803-8f82-e32e651b2e5a",
				sourceRef: "chat/file.jsonl#1426",
			},
		});
		const runtimeAssistant = hit(3, "lcm_record", "runtime-assistant", "works now. searched stargazy pie.", 0.03, {
			kind: "assistant",
			timestamp: "2026-05-09T10:07:11.188Z",
			source: { sourceRef: "runtime:def" },
		});
		const backfillAssistant = hit(4, "lcm_record", "backfill-assistant", "[assistant] works now. searched stargazy pie.", 0.04, {
			kind: "assistant",
			timestamp: "2026-05-09T10:07:15.076Z",
			source: {
				sourceMessageId: "msg_40a07659-8fd7-403b-a5aa-67a89e67c504",
				sourceRef: "chat/file.jsonl#1589",
			},
		});
		const sharedMessageA = hit(5, "lcm_record", "runtime-shared", "same message id text", 0.05, {
			kind: "assistant",
			timestamp: "2026-05-12T03:33:37.000Z",
			sourceMessageId: "same-message",
		});
		const sharedMessageB = hit(6, "lcm_record", "backfill-shared", "slightly different same message id text", 0.06, {
			kind: "assistant",
			timestamp: "2026-05-12T03:33:39.000Z",
			source: { sourceMessageId: "same-message" },
		});
		const store = new FakeStore(
			[runtimeUser, backfillUser, runtimeAssistant, backfillAssistant, sharedMessageA, sharedMessageB],
			new Map(),
		);

		const results = await retrieveMemory({
			query: "stargazy pie",
			store,
			embeddingProvider: null,
			useSemantic: false,
			scope: { corpora: ["lcm_record"] },
			limit: 8,
		});

		assert.deepEqual(
			results.map((result) => result.id),
			[1, 3, 5],
		);
	});

	it("does not deduplicate short generic text across unrelated turns", async () => {
		const first = hit(1, "lcm_record", "first-ok", "ok", 0.01, {
			kind: "user",
			timestamp: "2026-05-09T05:07:22.000Z",
		});
		const second = hit(2, "lcm_record", "second-ok", "ok", 0.02, {
			kind: "user",
			timestamp: "2026-05-09T05:12:22.000Z",
		});
		const store = new FakeStore([first, second], new Map());

		const results = await retrieveMemory({
			query: "ok",
			store,
			embeddingProvider: null,
			useSemantic: false,
			scope: { corpora: ["lcm_record"] },
			limit: 8,
		});

		assert.deepEqual(
			results.map((result) => result.id),
			[1, 2],
		);
	});

	it("returns no hits for empty queries", async () => {
		const store = new FakeStore([hit(1, "diary_chunk", "a", "unused", 0)], new Map());
		const provider = new FakeEmbeddingProvider();

		const results = await retrieveMemory({ query: "  ", store, embeddingProvider: provider });

		assert.deepEqual(results, []);
		assert.deepEqual(provider.queries, []);
	});
});
