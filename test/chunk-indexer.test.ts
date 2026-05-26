import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { ChunkIndexer } from "../src/memory/index/chunk-indexer.js";
import type { EmbeddingInput, EmbeddingProvider } from "../src/memory/index/embedding-provider.js";
import { MemoryIndexStore } from "../src/memory/index/store.js";

async function tempDbPath(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "familiar-chunk-indexer-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return resolve(dir, "memory.sqlite");
}

function openStore(path: string, dimensions = 3): MemoryIndexStore {
	return new MemoryIndexStore({
		path,
		embeddingProvider: "fake",
		embeddingModel: "fake-embedding",
		embeddingDimensions: dimensions,
	});
}

class FakeEmbeddingProvider implements EmbeddingProvider {
	readonly api = "fake";
	readonly provider = "fake";
	readonly model = "fake-embedding";
	readonly dimensions: number;
	readonly batches: EmbeddingInput[][] = [];

	constructor(dimensions = 3) {
		this.dimensions = dimensions;
	}

	async embed(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
		this.batches.push(inputs);
		return inputs.map((input) => this.vectorFor(input));
	}

	async embedOne(input: EmbeddingInput): Promise<Float32Array> {
		const [embedding] = await this.embed([input]);
		if (!embedding) throw new Error("missing embedding");
		return embedding;
	}

	private vectorFor(input: EmbeddingInput): Float32Array {
		const text = typeof input === "string" ? input : input.parts.map((part) => ("text" in part ? part.text : "")).join("");
		const values = Array.from({ length: this.dimensions }, (_, index) => text.length + index);
		return new Float32Array(values);
	}
}

describe("ChunkIndexer", () => {
	it("embeds only new unique chunk content and reuses stored hashes", async (t) => {
		const store = openStore(await tempDbPath(t));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			const first = await indexer.indexChunks([
				{ corpus: "diary_chunk", sourceId: "day.md", chunkIndex: 0, text: "same memory" },
				{ corpus: "diary_chunk", sourceId: "day.md", chunkIndex: 0, text: "same memory" },
				{ corpus: "diary_chunk", sourceId: "day.md", chunkIndex: 1, text: "new memory" },
			]);

			assert.equal(first.ids.length, 3);
			assert.equal(new Set(first.ids).size, 2);
			assert.equal(first.embedded, 2);
			assert.equal(provider.batches.length, 1);
			assert.deepEqual(provider.batches[0], ["same memory", "new memory"]);
			assert.equal(store.stats().indexed, 2);

			const second = await indexer.indexChunks([
				{ corpus: "diary_chunk", sourceId: "day.md", chunkIndex: 0, text: "same memory" },
			]);

			assert.deepEqual(second.ids, [first.ids[0]]);
			assert.equal(second.embedded, 0);
			assert.equal(second.reused, 1);
			assert.equal(provider.batches.length, 1);
		} finally {
			store.close();
		}
	});

	it("maps identical content from different sources to one stored chunk", async (t) => {
		const store = openStore(await tempDbPath(t));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			const result = await indexer.indexChunks([
				{ corpus: "diary_chunk", sourceId: "a.md", chunkIndex: 0, text: "shared memory" },
				{ corpus: "diary_chunk", sourceId: "b.md", chunkIndex: 0, text: "shared memory" },
			]);

			assert.equal(result.ids[0], result.ids[1]);
			assert.equal(result.embedded, 1);
			assert.equal(store.stats().indexed, 1);
			assert.deepEqual(
				store.getChunk(result.ids[0] as number)?.sources.map((source) => source.sourceId).sort(),
				["a.md", "b.md"],
			);
		} finally {
			store.close();
		}
	});

	it("dedupes identical text across different metadata roles", async (t) => {
		const store = openStore(await tempDbPath(t));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			const result = await indexer.indexChunks([
				{ corpus: "diary_chunk", sourceId: "a.md", chunkIndex: 0, text: "role-neutral memory", metadata: { role: "user" } },
				{
					corpus: "diary_chunk",
					sourceId: "b.md",
					chunkIndex: 0,
					text: "role-neutral memory",
					metadata: { role: "assistant" },
				},
			]);

			assert.equal(result.ids[0], result.ids[1]);
			assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get() as { n: number }).n, 1);
		} finally {
			store.close();
		}
	});

	it("removes FTS rows when chunks are deleted", async (t) => {
		const store = openStore(await tempDbPath(t));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			await indexer.indexChunks([
				{ corpus: "diary_chunk", sourceId: "a.md", chunkIndex: 0, text: "delete fts one" },
				{ corpus: "diary_chunk", sourceId: "b.md", chunkIndex: 0, text: "delete fts two" },
			]);

			assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as { n: number }).n, 2);
			store.deleteBySource("diary_chunk", "a.md");
			assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as { n: number }).n, 1);
		} finally {
			store.close();
		}
	});

	it("replaces source chunks while preserving unchanged rows without re-embedding", async (t) => {
		const store = openStore(await tempDbPath(t));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			const first = await indexer.replaceSource("diary_chunk", "day.md", [
				{ chunkIndex: 0, text: "kept memory" },
				{ chunkIndex: 1, text: "old memory" },
			]);
			const keptId = first.ids[0];

			const second = await indexer.replaceSource("diary_chunk", "day.md", [
				{ chunkIndex: 0, text: "kept memory" },
				{ chunkIndex: 1, text: "fresh memory" },
			]);

			assert.equal(second.ids[0], keptId);
			assert.equal(second.embedded, 1);
			assert.equal(provider.batches.length, 2);
			assert.deepEqual(provider.batches[1], ["fresh memory"]);
			assert.equal(store.searchLexical("old", 5).length, 0);
			assert.equal(store.searchLexical("fresh", 5).length, 1);
			assert.equal(store.searchLexical("kept", 5).length, 1);
			assert.equal(store.stats().indexed, 2);
		} finally {
			store.close();
		}
	});

	it("uses supplied embeddings and leaves dimension validation to the store", async (t) => {
		const store = openStore(await tempDbPath(t));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			await assert.rejects(
				() =>
					indexer.indexChunks([
						{
							corpus: "diary_chunk",
							sourceId: "bad.md",
							text: "bad vector",
							embedding: new Float32Array([1, 2]),
						},
					]),
				/Embedding dimension mismatch/,
			);
			assert.equal(provider.batches.length, 0);

			const result = await indexer.indexChunks([
				{
					corpus: "diary_chunk",
					sourceId: "good.md",
					text: "provided vector",
					embedding: new Float32Array([1, 2, 3]),
				},
			]);
			assert.equal(result.embedded, 0);
			assert.equal(provider.batches.length, 0);
			assert.equal(store.getChunk(result.ids[0] as number)?.text, "provided vector");

			const duplicateResult = await indexer.indexChunks([
				{ corpus: "diary_chunk", sourceId: "duplicate.md", text: "same supplied" },
				{
					corpus: "diary_chunk",
					sourceId: "duplicate.md",
					text: "same supplied",
					embedding: new Float32Array([3, 2, 1]),
				},
			]);
			assert.equal(duplicateResult.embedded, 0);
			assert.equal(new Set(duplicateResult.ids).size, 1);
			assert.equal(provider.batches.length, 0);
		} finally {
			store.close();
		}
	});

	it("skips blank chunks and clears a source when replacement has no content", async (t) => {
		const store = openStore(await tempDbPath(t));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			await indexer.replaceSource("diary_chunk", "empty.md", [{ chunkIndex: 0, text: "old memory" }]);

			const result = await indexer.replaceSource("diary_chunk", "empty.md", [
				{ chunkIndex: 0, text: "  " },
				{ chunkIndex: 1, text: "\n" },
			]);

			assert.deepEqual(result.ids, []);
			assert.equal(result.embedded, 0);
			assert.equal(result.skipped, 2);
			assert.equal(store.searchLexical("old", 5).length, 0);
			assert.equal(store.stats().indexed, 0);
		} finally {
			store.close();
		}
	});
});
