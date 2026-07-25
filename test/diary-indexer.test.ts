import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { describe, it } from "node:test";

import type { Config } from "../src/config/index.js";
import {
	indexAllDiaryFiles,
	indexDiaryFile,
	listDiaryMarkdownFiles,
	removeDiaryFileIndex,
} from "../src/memory/diary/indexer.js";
import { ChunkIndexer } from "../src/memory/index/chunk-indexer.js";
import type { EmbeddingInput, EmbeddingProvider } from "../src/memory/index/embedding-provider.js";
import { MemoryIndexStore } from "../src/memory/index/store.js";

async function tempRoot(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "familiar-diary-indexer-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function configFor(diariesDir: string): Config {
	return { memory: { diariesDir } } as Config;
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
	readonly dimensions = 3;
	readonly batches: EmbeddingInput[][] = [];

	async embed(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
		this.batches.push(inputs);
		return inputs.map((input) => {
			const text = typeof input === "string" ? input : input.parts.map((part) => ("text" in part ? part.text : "")).join("");
			return new Float32Array([text.length, text.charCodeAt(0) || 0, 1]);
		});
	}

	async embedOne(input: EmbeddingInput): Promise<Float32Array> {
		const [embedding] = await this.embed([input]);
		if (!embedding) throw new Error("missing embedding");
		return embedding;
	}
}

describe("diary file indexer", () => {
	it("lists and indexes only dated markdown diary files from config.memory.diariesDir", async (t) => {
		const root = await tempRoot(t);
		const diariesDir = resolve(root, "diaries");
		await mkdir(diariesDir);
		await writeFile(resolve(diariesDir, "2026-05-09.md"), "# Morning\nTea mattered.", "utf8");
		await writeFile(resolve(diariesDir, "2026-05-10.md"), "Quiet ordinary entry.", "utf8");
		await writeFile(resolve(diariesDir, "notes.md"), "not a dated diary", "utf8");
		await writeFile(resolve(diariesDir, "2026-05.md"), "wrong date shape", "utf8");
		await writeFile(resolve(diariesDir, "2026-05-11.txt"), "wrong extension", "utf8");
		await mkdir(resolve(diariesDir, "2026-05-12.md"));

		const config = configFor(diariesDir);
		assert.deepEqual(
			(await listDiaryMarkdownFiles(config)).map((path) => basename(path)),
			["2026-05-09.md", "2026-05-10.md"],
		);

		const store = openStore(resolve(root, "memory.sqlite"));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			const result = await indexAllDiaryFiles({ config, indexer });

			assert.deepEqual(
				result.files.map((file) => file.sourceId),
				["2026-05-09.md", "2026-05-10.md"],
			);
			assert.equal(store.stats().indexed, 2);
			assert.deepEqual(provider.batches, [["Tea mattered."], ["Quiet ordinary entry."]]);
		} finally {
			store.close();
		}
	});

	it("indexes one diary file and clears prior chunks when the file becomes empty", async (t) => {
		const root = await tempRoot(t);
		const diariesDir = resolve(root, "diaries");
		await mkdir(diariesDir);
		const diaryPath = resolve(diariesDir, "2026-05-10.md");
		await writeFile(diaryPath, "# One\nA remembered thing.", "utf8");

		const store = openStore(resolve(root, "memory.sqlite"));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			const first = await indexDiaryFile({ config: configFor(diariesDir), indexer, path: "2026-05-10.md" });

			assert.equal("skipped" in first, false);
			assert.equal(store.stats().indexed, 1);
			assert.equal(store.searchLexical("remembered", 5).length, 1);

			await writeFile(diaryPath, "  \n\n", "utf8");
			const second = await indexDiaryFile({ config: configFor(diariesDir), indexer, path: diaryPath });

			assert.equal("skipped" in second, false);
			assert.deepEqual("skipped" in second ? [] : second.result.ids, []);
			assert.equal(store.searchLexical("remembered", 5).length, 0);
			assert.equal(store.stats().indexed, 0);
			assert.equal(provider.batches.length, 1);
		} finally {
			store.close();
		}
	});

	it("skips unchanged diary files when source state already matches", async (t) => {
		const root = await tempRoot(t);
		const diariesDir = resolve(root, "diaries");
		await mkdir(diariesDir);
		const diaryPath = resolve(diariesDir, "2026-05-10.md");
		await writeFile(diaryPath, "A remembered thing.", "utf8");

		const store = openStore(resolve(root, "memory.sqlite"));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			const first = await indexDiaryFile({ config: configFor(diariesDir), indexer, store, path: diaryPath });
			assert.equal("skipped" in first, false);
			if ("skipped" in first) throw new Error("expected first diary indexing to run");
			assert.equal(first.result.embedded, 1);
			assert.equal(provider.batches.length, 1);

			const second = await indexDiaryFile({ config: configFor(diariesDir), indexer, store, path: diaryPath });

			assert.equal("skipped" in second, false);
			if ("skipped" in second) throw new Error("expected second diary indexing to return index result");
			assert.equal(second.skippedUnchanged, true);
			assert.deepEqual(second.result, { ids: [], embedded: 0, reused: 0, skipped: 0 });
			assert.equal(provider.batches.length, 1);

			await writeFile(diaryPath, "A remembered thing with a new tail.", "utf8");
			const third = await indexDiaryFile({ config: configFor(diariesDir), indexer, store, path: diaryPath });

			assert.equal("skipped" in third, false);
			if ("skipped" in third) throw new Error("expected changed diary indexing to run");
			assert.equal(third.skippedUnchanged, undefined);
			assert.equal(third.result.embedded, 1);
			assert.equal(provider.batches.length, 2);
		} finally {
			store.close();
		}
	});

	it("reuses embeddings when source state is unavailable", async (t) => {
		const root = await tempRoot(t);
		const diariesDir = resolve(root, "diaries");
		await mkdir(diariesDir);
		await writeFile(resolve(diariesDir, "2026-05-10.md"), "A remembered thing.", "utf8");

		const store = openStore(resolve(root, "memory.sqlite"));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			await indexAllDiaryFiles({ config: configFor(diariesDir), indexer });
			await indexAllDiaryFiles({ config: configFor(diariesDir), indexer });

			assert.equal(provider.batches.length, 1);
			assert.equal(store.stats().indexed, 1);
		} finally {
			store.close();
		}
	});

	it("clears indexed chunks for a deleted diary file", async (t) => {
		const root = await tempRoot(t);
		const diariesDir = resolve(root, "diaries");
		await mkdir(diariesDir);
		const diaryPath = resolve(diariesDir, "2026-05-10.md");
		await writeFile(diaryPath, "A remembered thing.", "utf8");

		const store = openStore(resolve(root, "memory.sqlite"));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			await indexDiaryFile({ config: configFor(diariesDir), indexer, path: diaryPath });
			assert.equal(store.searchLexical("remembered", 5).length, 1);

			await rm(diaryPath);
			await removeDiaryFileIndex({ config: configFor(diariesDir), indexer, path: diaryPath });

			assert.equal(store.searchLexical("remembered", 5).length, 0);
			assert.equal(store.stats().indexed, 0);
		} finally {
			store.close();
		}
	});

	it("skips invalid single-file requests by default and can fail loudly", async (t) => {
		const root = await tempRoot(t);
		const diariesDir = resolve(root, "diaries");
		await mkdir(diariesDir);
		await writeFile(resolve(diariesDir, "notes.md"), "not a dated diary", "utf8");

		const store = openStore(resolve(root, "memory.sqlite"));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			const skipped = await indexDiaryFile({ config: configFor(diariesDir), indexer, path: "notes.md" });

			assert.deepEqual(skipped, {
				path: resolve(diariesDir, "notes.md"),
				sourceId: "notes.md",
				skipped: true,
				reason: "not-dated-markdown",
			});
			assert.equal(store.stats().indexed, 0);
			assert.equal(provider.batches.length, 0);

			await assert.rejects(
				() => indexDiaryFile({ config: configFor(diariesDir), indexer, path: "notes.md", skipInvalid: false }),
				/Diary file must be named YYYY-MM-DD\.md/,
			);
		} finally {
			store.close();
		}
	});

	it("indexes zero diary files when the diary directory is missing", async (t) => {
		const root = await tempRoot(t);
		const diariesDir = resolve(root, "missing-diaries");
		const store = openStore(resolve(root, "memory.sqlite"));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			const result = await indexAllDiaryFiles({ config: configFor(diariesDir), indexer });

			assert.deepEqual(result.files, []);
			assert.equal(store.stats().indexed, 0);
			assert.equal(provider.batches.length, 0);
		} finally {
			store.close();
		}
	});
});
