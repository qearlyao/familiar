import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import { runDoctor } from "../src/memory/doctor.js";
import { createMemoryContentHash, MemoryIndexStore } from "../src/memory/index/store.js";
import { __memoryVecTest } from "../src/memory/index/vec.js";
import { LcmStore } from "../src/memory/lcm/store.js";

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

function openStoreWithModel(path: string, model: string, dimensions = 3): MemoryIndexStore {
	return new MemoryIndexStore({
		path,
		embeddingProvider: "google",
		embeddingModel: model,
		embeddingDimensions: dimensions,
	});
}

function vector(values: number[]): Float32Array {
	return new Float32Array(values);
}

describe("MemoryIndexStore", () => {
	afterEach(() => {
		__memoryVecTest.setLoader(null);
	});

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

	it("sqlite-vec unavailable soft-fall uses linear scan", async () => {
		__memoryVecTest.setLoader(() => {
			throw new Error("sqlite-vec unavailable in test");
		});
		const store = openStore(await tempDbPath());
		try {
			store.insertChunks([
				{ corpus: "diary_chunk", sourceId: "a", text: "near vector", embedding: vector([1, 0, 0]) },
				{ corpus: "diary_chunk", sourceId: "b", text: "far vector", embedding: vector([0, 1, 0]) },
			]);

			const semantic = store.searchSemantic(vector([0.9, 0.1, 0]), 2);

			assert.equal(semantic[0]?.chunk.sourceId, "a");
			assert.equal(semantic[1]?.chunk.sourceId, "b");
			assert.equal(store.stats().vectorAvailable, false);
			assert.equal(store.stats().vectorCapability, "blob-js");
		} finally {
			store.close();
		}
	});

	it("sqlite-vec available matches linear-scan baseline", async (t) => {
		const sqliteVec = __memoryVecTest.probePackage();
		if (!sqliteVec) {
			t.skip("sqlite-vec is not installed in this environment");
			return;
		}
		const path = await tempDbPath();
		const store = openStore(path);
		try {
			const inputs = Array.from({ length: 50 }, (_, index) => {
				const values = vector([index + 1, 50 - index, (index % 7) + 1]);
				return {
					corpus: "diary_chunk",
					sourceId: `chunk-${index}`,
					text: `semantic chunk ${index}`,
					embedding: values,
				};
			});
			store.insertChunks(inputs);
			assert.equal(store.stats().vectorAvailable, true);

			const query = vector([42, 8, 1]);
			const vecHits = store.searchSemantic(query, 10).map((hit) => hit.id);
			store.db.prepare("UPDATE memory_meta SET v = 'blob-js' WHERE k = 'vector_capability'").run();
			const linearHits = store.searchSemantic(query, 10).map((hit) => hit.id);

			assert.deepEqual(vecHits, linearHits);
		} finally {
			store.close();
		}
	});

	it("backfills sqlite-vec rows when upgrading an existing blob-js database", async (t) => {
		__memoryVecTest.setLoader(() => {
			throw new Error("sqlite-vec unavailable during initial create");
		});
		const path = await tempDbPath();
		const firstStore = openStore(path);
		try {
			firstStore.insertChunks([
				{ corpus: "diary_chunk", sourceId: "a", text: "near upgrade vector", embedding: vector([1, 0, 0]) },
				{ corpus: "diary_chunk", sourceId: "b", text: "middle upgrade vector", embedding: vector([0, 1, 0]) },
				{ corpus: "diary_chunk", sourceId: "c", text: "far upgrade vector", embedding: vector([0, 0, 1]) },
			]);
			assert.equal(firstStore.stats().vectorCapability, "blob-js");
		} finally {
			firstStore.close();
		}

		if (!__memoryVecTest.probePackage()) {
			t.skip("sqlite-vec is not installed in this environment");
			return;
		}
		__memoryVecTest.setLoader(null);
		const secondStore = openStore(path);
		try {
			if (!secondStore.stats().vectorAvailable) {
				t.skip("sqlite-vec is not loadable in this environment");
				return;
			}
			assert.equal((secondStore.db.prepare("SELECT COUNT(*) AS n FROM memory_vec").get() as { n: number }).n, 3);
			assert.equal(secondStore.searchSemantic(vector([0.9, 0.1, 0]), 2)[0]?.chunk.sourceId, "a");
		} finally {
			secondStore.close();
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

	it("allows trailing-star FTS prefix queries", async () => {
		const store = openStore(await tempDbPath());
		try {
			store.insertChunks([
				{
					corpus: "diary_chunk",
					sourceId: "prefix",
					text: "The lanternlight stayed visible.",
					embedding: vector([1, 0, 0]),
				},
				{
					corpus: "diary_chunk",
					sourceId: "other",
					text: "The lunch plan stayed visible.",
					embedding: vector([0, 1, 0]),
				},
			]);

			const hits = store.searchLexical("lantern*", 5);

			assert.deepEqual(
				hits.map((hit) => hit.chunk.sourceId),
				["prefix"],
			);
			assert.deepEqual(store.searchLexical("*", 5), []);
		} finally {
			store.close();
		}
	});

	it("sanitizes prefix query bodies before preserving trailing star", async () => {
		const store = openStore(await tempDbPath());
		try {
			store.insertChunk({
				corpus: "diary_chunk",
				sourceId: "prefix",
				text: "toolbar marker",
				embedding: vector([1, 0, 0]),
			});

			assert.equal(store.searchLexical("tool-*", 5).length, 1);
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

	it("sets requires_reindex after embedding config changes", async () => {
		const path = await tempDbPath();
		const firstStore = openStore(path);
		try {
			firstStore.insertChunk({
				corpus: "lcm_summary",
				sourceId: "sum1",
				text: "summary survives until dimension change",
				embedding: vector([1, 0, 0]),
			});
		} finally {
			firstStore.close();
		}

		const secondStore = openStoreWithModel(path, "gemini-embedding-2", 4);
		try {
			assert.equal(secondStore.stats().indexed, 0);
			assert.equal(
				(secondStore.db.prepare("SELECT v FROM memory_meta WHERE k = 'requires_reindex'").get() as { v: string }).v,
				"1",
			);
			assert.equal(secondStore.stats().requiresReindex, true);
		} finally {
			secondStore.close();
		}
	});

	it("drops stale memory_vec rows when embedding dimensions change without sqlite-vec loaded", async () => {
		const path = await tempDbPath();
		const firstStore = openStore(path);
		try {
			firstStore.insertChunk({
				corpus: "lcm_summary",
				sourceId: "sum1",
				text: "summary gets stale vector table",
				embedding: vector([1, 0, 0]),
			});
			firstStore.db.prepare("CREATE TABLE IF NOT EXISTS memory_vec(rowid INTEGER PRIMARY KEY, embedding BLOB)").run();
			firstStore.db.prepare("INSERT INTO memory_vec(rowid, embedding) VALUES (?, ?)").run(1, Buffer.from([1, 2, 3]));
			assert.equal((firstStore.db.prepare("SELECT COUNT(*) AS n FROM memory_vec").get() as { n: number }).n, 1);
		} finally {
			firstStore.close();
		}

		__memoryVecTest.setLoader(() => {
			throw new Error("sqlite-vec unavailable during dimension change");
		});
		const secondStore = openStoreWithModel(path, "gemini-embedding-2", 4);
		try {
			assert.equal(secondStore.stats().indexed, 0);
			const row = secondStore.db
				.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'memory_vec'")
				.get() as { ok: number } | undefined;
			assert.equal(row, undefined);
		} finally {
			secondStore.close();
		}
	});

	it("doctor reports requires_reindex and clean does not clear it", async () => {
		const path = await tempDbPath();
		const lcmPath = await tempDbPath();
		const firstStore = openStore(path);
		try {
			firstStore.insertChunk({
				corpus: "lcm_summary",
				sourceId: "sum1",
				text: "summary survives until doctor sees reindex",
				embedding: vector([1, 0, 0]),
			});
		} finally {
			firstStore.close();
		}

		const index = openStoreWithModel(path, "gemini-embedding-2", 4);
		const lcm = new LcmStore({ path: lcmPath });
		try {
			const report = runDoctor({ lcm, index });
			assert.ok(report.findings.some((finding) => finding.kind === "requires_reindex"));

			runDoctor({ lcm, index }, {});
			assert.equal(
				(index.db.prepare("SELECT v FROM memory_meta WHERE k = 'requires_reindex'").get() as { v: string }).v,
				"1",
			);
		} finally {
			lcm.close();
			index.close();
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
