import assert from "node:assert/strict";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { Config } from "../src/config/index.js";
import { ChunkIndexer } from "../src/memory/index/chunk-indexer.js";
import type { EmbeddingInput, EmbeddingProvider } from "../src/memory/index/embedding-provider.js";
import { MemoryIndexStore } from "../src/memory/index/store.js";
import { indexNoteFiles, NOTE_CORPUS } from "../src/memory/notes.js";
import { createTempDataDir } from "./helpers.js";

const fakeEmbeddings: EmbeddingProvider = {
	api: "fake",
	provider: "fake",
	model: "fake-embedding",
	dimensions: 3,
	async embed(inputs: EmbeddingInput[]) {
		return inputs.map(() => new Float32Array([1, 0, 0]));
	},
	async embedOne() {
		return new Float32Array([1, 0, 0]);
	},
};

describe("note indexer", () => {
	it("indexes notes with their topic, follows edits, and drops renamed or deleted notes", async (t) => {
		const root = await createTempDataDir(t);
		const notesDir = resolve(root, "notes");
		await mkdir(notesDir);
		const store = new MemoryIndexStore({
			path: resolve(root, "index.sqlite"),
			embeddingProvider: "fake",
			embeddingModel: "fake-embedding",
			embeddingDimensions: 3,
		});
		t.after(() => store.close());
		const options = {
			config: { memory: { notesDir } } as Config,
			indexer: new ChunkIndexer({ store, embeddingProvider: fakeEmbeddings }),
			store,
		};
		const search = (query: string) =>
			store.searchLexical(query, { corpus: NOTE_CORPUS, limit: 5 }).map((hit) => hit.chunk.text);

		await writeFile(resolve(notesDir, "her.md"), "## Game of Thrones\n- Favourite: Ghost the direwolf\n", "utf8");
		await writeFile(resolve(notesDir, "skip.txt"), "direwolf in a text file", "utf8");
		assert.deepEqual(await indexNoteFiles(options), { chunks: 1 });
		assert.deepEqual(search("thrones"), ["her / Game of Thrones\nFavourite: Ghost the direwolf"]);

		await writeFile(resolve(notesDir, "her.md"), "## Game of Thrones\n- Favourite: Arya\n", "utf8");
		await indexNoteFiles(options);
		assert.deepEqual(search("direwolf"), []);
		assert.equal(search("arya").length, 1);

		await writeFile(
			resolve(notesDir, "her.md"),
			"## Kyoto trip\nDate: 2025-04-12\nStayed in Gion\n\n## Anniversary\nDate: June 14\n",
			"utf8",
		);
		await indexNoteFiles(options);
		assert.deepEqual(search("date").sort(), ["her / Anniversary\nDate: June 14", "her / Kyoto trip\nDate: 2025-04-12"]);

		await rename(resolve(notesDir, "her.md"), resolve(notesDir, "shows.md"));
		await indexNoteFiles(options);
		assert.deepEqual(store.sourceIds(NOTE_CORPUS), ["shows.md"]);

		await rm(resolve(notesDir, "shows.md"));
		await indexNoteFiles(options);
		assert.deepEqual(store.sourceIds(NOTE_CORPUS), []);
	});
});
