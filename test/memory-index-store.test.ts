import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { createMemoryContentHash, MemoryIndexStore } from "../src/memory/index/store.js";

async function tempDbPath(): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "familiar-memory-index-"));
	return resolve(dir, "memory.sqlite");
}

function openStore(path: string, dimensions = 3): MemoryIndexStore {
	return new MemoryIndexStore({
		path,
		embeddingProvider: "google",
		embeddingModel: "gemini-embedding-2",
		embeddingDimensions: dimensions,
	});
}

function vector(values: number[]): Float32Array {
	return new Float32Array(values);
}

describe("MemoryIndexStore", () => {
	it("inserts, dedupes, and reads chunks", async () => {
		const store = openStore(await tempDbPath());
		try {
			const first = store.insertChunk({
				corpus: "diary_chunk",
				sourceId: "2026-05-10.md",
				sourceRef: "memories/diaries/2026-05-10.md",
				chunkIndex: 0,
				text: "A quiet evening with warm continuity.",
				metadata: { valence: 0.8 },
				embedding: vector([1, 0, 0]),
			});
			const second = store.insertChunk({
				corpus: "diary_chunk",
				sourceId: "2026-05-10.md",
				sourceRef: "memories/diaries/2026-05-10.md",
				chunkIndex: 0,
				text: "A quiet evening with warm continuity.",
				metadata: { valence: 0.8 },
				embedding: vector([1, 0, 0]),
			});

			assert.equal(second, first);
			assert.equal(store.stats().indexed, 1);
			const chunk = store.getChunk(first);
			assert.equal(chunk?.text, "A quiet evening with warm continuity.");
			assert.deepEqual(chunk?.metadata, { valence: 0.8 });
		} finally {
			store.close();
		}
	});

	it("searches with FTS and semantic fallback", async () => {
		const store = openStore(await tempDbPath());
		try {
			store.insertChunks([
				{
					corpus: "diary_chunk",
					sourceId: "a",
					text: "The blue lantern memory felt close.",
					embedding: vector([1, 0, 0]),
				},
				{
					corpus: "lcm_record",
					sourceId: "b",
					text: "We discussed database migrations and indexes.",
					embedding: vector([0, 1, 0]),
				},
			]);

			const lexical = store.searchLexical("lantern", 5);
			assert.equal(lexical.length, 1);
			assert.equal(lexical[0]?.chunk.sourceId, "a");
			assert.equal(store.searchLexical("indexes", { corpus: "diary_chunk" }).length, 0);
			assert.equal(store.searchLexical("indexes", { corpus: "lcm_record" }).length, 1);

			const semantic = store.searchSemantic(vector([0.9, 0.1, 0]), 2);
			assert.equal(semantic[0]?.chunk.sourceId, "a");
			assert.equal(semantic[1]?.chunk.sourceId, "b");
			assert.equal(store.searchSemantic(vector([0.9, 0.1, 0]), { corpus: "lcm_record" })[0]?.chunk.sourceId, "b");
		} finally {
			store.close();
		}
	});

	it("dedupes identical content across sources and preserves mappings until the last source is deleted", async () => {
		const store = openStore(await tempDbPath());
		try {
			const ids = store.insertChunks([
				{ corpus: "diary_chunk", sourceId: "source-a", chunkIndex: 0, text: "X", embedding: vector([1, 0, 0]) },
				{ corpus: "diary_chunk", sourceId: "source-b", chunkIndex: 0, text: "X", embedding: vector([0, 1, 0]) },
			]);

			assert.equal(ids[0], ids[1]);
			assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get() as { n: number }).n, 1);
			assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM memory_index_sources").get() as { n: number }).n, 2);
			assert.deepEqual(
				store.searchLexical("X", 5)[0]?.chunk.sources.map((source) => source.sourceId).sort(),
				["source-a", "source-b"],
			);

			store.deleteBySource("diary_chunk", "source-a");
			assert.equal(store.searchLexical("X", 5).length, 1);
			assert.deepEqual(
				store.searchLexical("X", 5)[0]?.chunk.sources.map((source) => source.sourceId),
				["source-b"],
			);

			store.deleteBySource("diary_chunk", "source-b");
			assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get() as { n: number }).n, 0);
			assert.equal(store.searchLexical("X", 5).length, 0);
		} finally {
			store.close();
		}
	});

	it("replaces a source mapping when the same source chunk index changes content", async () => {
		const store = openStore(await tempDbPath());
		try {
			store.replaceSource("diary_chunk", "day.md", [
				{ corpus: "ignored", sourceId: "ignored", chunkIndex: 0, text: "old indexed text", embedding: vector([1, 0, 0]) },
			]);
			store.replaceSource("diary_chunk", "day.md", [
				{ corpus: "ignored", sourceId: "ignored", chunkIndex: 0, text: "new indexed text", embedding: vector([0, 1, 0]) },
			]);

			assert.equal(store.searchLexical("old", 5).length, 0);
			assert.equal(store.searchLexical("new", 5).length, 1);
			assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM memory_index_sources").get() as { n: number }).n, 1);
		} finally {
			store.close();
		}
	});

	it("quotes natural-language FTS queries with punctuation", async () => {
		const store = openStore(await tempDbPath());
		try {
			store.insertChunks([
				{
					corpus: "diary_chunk",
					sourceId: "punctuated",
					text: "Did we keep the agent-runtime handoff alive?",
					embedding: vector([1, 0, 0]),
				},
				{
					corpus: "diary_chunk",
					sourceId: "other",
					text: "The calendar mentioned lunch plans.",
					embedding: vector([0, 1, 0]),
				},
			]);

			const hits = store.searchLexical("agent-runtime: alive?", 5);

			assert.deepEqual(
				hits.map((hit) => hit.chunk.sourceId),
				["punctuated"],
			);
			assert.deepEqual(store.searchLexical("?:-", 5), []);
		} finally {
			store.close();
		}
	});

	it("replaces and deletes source chunks transactionally", async () => {
		const store = openStore(await tempDbPath());
		try {
			store.insertChunks([
				{ corpus: "diary_chunk", sourceId: "day.md", chunkIndex: 0, text: "old one", embedding: vector([1, 0, 0]) },
				{ corpus: "diary_chunk", sourceId: "day.md", chunkIndex: 1, text: "old two", embedding: vector([0, 1, 0]) },
				{ corpus: "diary_chunk", sourceId: "other.md", chunkIndex: 0, text: "keep this", embedding: vector([0, 0, 1]) },
			]);

			const ids = store.replaceSource("diary_chunk", "day.md", [
				{ corpus: "ignored", sourceId: "ignored", chunkIndex: 0, text: "new memory", embedding: vector([1, 1, 0]) },
			]);

			assert.equal(ids.length, 1);
			assert.equal(store.searchLexical("old", 5).length, 0);
			assert.equal(store.searchLexical("new", 5).length, 1);
			assert.equal(store.searchLexical("keep", 5).length, 1);

			store.deleteBySource("diary_chunk", "day.md");
			assert.equal(store.searchLexical("new", 5).length, 0);
			assert.equal(store.stats().indexed, 1);
		} finally {
			store.close();
		}
	});

	it("deletes stale source rows while preserving selected hashes", async () => {
		const store = openStore(await tempDbPath());
		try {
			const ids = store.insertChunks([
				{ corpus: "diary_chunk", sourceId: "day.md", chunkIndex: 0, text: "keep memory", embedding: vector([1, 0, 0]) },
				{ corpus: "diary_chunk", sourceId: "day.md", chunkIndex: 1, text: "drop memory", embedding: vector([0, 1, 0]) },
				{ corpus: "diary_chunk", sourceId: "other.md", chunkIndex: 0, text: "other memory", embedding: vector([0, 0, 1]) },
			]);
			const keepHash = store.getChunk(ids[0] as number)?.contentHash;
			assert.ok(keepHash);

			store.deleteBySourceExceptHashes("diary_chunk", "day.md", [keepHash]);

			assert.equal(store.searchLexical("keep", 5).length, 1);
			assert.equal(store.searchLexical("drop", 5).length, 0);
			assert.equal(store.searchLexical("other", 5).length, 1);
			assert.equal(store.stats().indexed, 2);
		} finally {
			store.close();
		}
	});

	it("finds present hashes and clears stale rows on model changes", async () => {
		const path = await tempDbPath();
		const firstStore = openStore(path);
		let hash: string;
		try {
			const id = firstStore.insertChunk({
				corpus: "lcm_summary",
				sourceId: "sum1",
				text: "summary survives until model change",
				embedding: vector([1, 0, 0]),
			});
			const chunk = firstStore.getChunk(id);
			assert.ok(chunk);
			hash = createMemoryContentHash({
				corpus: "lcm_summary",
				sourceId: "sum1",
				chunkIndex: 0,
				text: "summary survives until model change",
				embeddingModel: "gemini-embedding-2",
				embeddingDimensions: 3,
			});
			assert.equal(chunk.contentHash, hash);
			assert.deepEqual(firstStore.whichHashesPresent([hash, "missing"]), new Map([[hash, id]]));
		} finally {
			firstStore.close();
		}

		const secondStore = new MemoryIndexStore({
			path,
			embeddingProvider: "google",
			embeddingModel: "different-model",
			embeddingDimensions: 3,
		});
		try {
			assert.equal(secondStore.stats().indexed, 0);
			assert.equal(secondStore.searchLexical("summary", 5).length, 0);
		} finally {
			secondStore.close();
		}
	});

	it("rejects vectors with the wrong dimensionality", async () => {
		const store = openStore(await tempDbPath());
		try {
			assert.throws(
				() =>
					store.insertChunk({
						corpus: "diary_chunk",
						text: "bad vector",
						embedding: vector([1, 2]),
					}),
				/Embedding dimension mismatch/,
			);
			assert.throws(() => store.searchSemantic(vector([1, 2]), 1), /Query vector dimension mismatch/);
		} finally {
			store.close();
		}
	});
});
