import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { Config } from "../src/config.js";
import { indexAllDiaryFiles, indexDiaryFile, listDiaryMarkdownFiles } from "../src/memory/diary/index.js";
import { ChunkIndexer } from "../src/memory/index/chunk-indexer.js";
import type { EmbeddingInput, EmbeddingProvider } from "../src/memory/index/embedding-provider.js";
import { MemoryIndexStore } from "../src/memory/index/store.js";

async function tempRoot(): Promise<string> {
	return mkdtemp(resolve(tmpdir(), "familiar-diary-indexer-"));
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
	it("lists and indexes only dated markdown diary files from config.memory.diariesDir", async () => {
		const root = await tempRoot();
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
			(await listDiaryMarkdownFiles(config)).map((path) => path.replace(`${diariesDir}/`, "")),
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

	it("indexes one diary file and clears prior chunks when the file becomes empty", async () => {
		const root = await tempRoot();
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

	it("skips invalid single-file requests by default and can fail loudly", async () => {
		const root = await tempRoot();
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

	it("indexes zero diary files when the diary directory is missing", async () => {
		const root = await tempRoot();
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
