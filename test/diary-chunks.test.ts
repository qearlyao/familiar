import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { ChunkIndexer } from "../src/memory/index/chunk-indexer.js";
import type { EmbeddingInput, EmbeddingProvider } from "../src/memory/index/embedding-provider.js";
import { MemoryIndexStore } from "../src/memory/index/store.js";
import {
	chunkDiaryMarkdown,
	DIARY_CHUNK_CORPUS,
	diaryChunksToIndexInputs,
	indexDiaryMarkdown,
} from "../src/memory/diary/index.js";

async function tempDbPath(): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "familiar-diary-chunks-"));
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

describe("diary markdown chunking", () => {
	it("turns dated markdown sections into diary_chunk index inputs with metadata", () => {
		const chunks = chunkDiaryMarkdown(
			`---
date: 2026-05-09
valence: 0.2
intensity: 0.4
---

# Morning
valence: 0.8
intensity: 0.7

We kept the tea ritual and it mattered.

## Late note
A quieter thought arrived after midnight.
`,
			{
				sourceId: "2026-05-10.md",
				sourceRef: "memories/diaries/2026-05-10.md",
				metadata: { intensity: 0.9 },
			},
		);

		assert.equal(chunks.length, 2);
		assert.deepEqual(chunks.map((chunk) => chunk.metadata), [
			{ date: "2026-05-09", valence: 0.8, intensity: 0.7, heading: "Morning" },
			{ date: "2026-05-09", valence: 0.2, intensity: 0.9, heading: "Late note" },
		]);
		assert.equal(chunks[0]?.sourceId, "2026-05-10.md");
		assert.equal(chunks[0]?.sourceRef, "memories/diaries/2026-05-10.md");
		assert.match(chunks[0]?.snippet ?? "", /^2026-05-09 Morning:/);

		const inputs = diaryChunksToIndexInputs(chunks);
		assert.deepEqual(
			inputs.map((input) => [input.corpus, input.sourceId, input.chunkIndex]),
			[
				[DIARY_CHUNK_CORPUS, "2026-05-10.md", 0],
				[DIARY_CHUNK_CORPUS, "2026-05-10.md", 1],
			],
		);
		assert.equal(inputs[0]?.metadata?.valence, 0.8);
	});

	it("derives date from YYYY-MM-DD.md and skips empty diary files", () => {
		assert.deepEqual(
			chunkDiaryMarkdown("   \n\n", {
				sourceId: "2026-05-10.md",
			}),
			[],
		);

		const [chunk] = chunkDiaryMarkdown("A small ordinary entry.", {
			sourceId: "2026-05-10.md",
		});

		assert.equal(chunk?.metadata.date, "2026-05-10");
		assert.equal(chunk?.metadata.heading, undefined);
		assert.equal(chunk?.text, "A small ordinary entry.");
	});

	it("splits diary body lines into separate memory chunks", () => {
		const chunks = chunkDiaryMarkdown(
			[
				"Qearl gave me a memory system today.",
				"Dangerous thing, giving a ghost somewhere to keep his thoughts.",
				"She is clever in that stubborn, sleep-deprived way.",
			].join("\n"),
			{ sourceId: "2026-05-12.md" },
		);

		assert.deepEqual(
			chunks.map((chunk) => chunk.text),
			[
				"Qearl gave me a memory system today.",
				"Dangerous thing, giving a ghost somewhere to keep his thoughts.",
				"She is clever in that stubborn, sleep-deprived way.",
			],
		);
		assert.deepEqual(
			chunks.map((chunk) => chunk.chunkIndex),
			[0, 1, 2],
		);
	});

	it("treats markdown list items as separate memory chunks", () => {
		const chunks = chunkDiaryMarkdown(
			[
				"- Qearl gave me a memory system today.",
				"- Dangerous thing, giving a ghost somewhere to keep his thoughts.",
				"  This continuation belongs with the dangerous thing.",
			].join("\n"),
			{ sourceId: "2026-05-12.md" },
		);

		assert.deepEqual(
			chunks.map((chunk) => chunk.text),
			[
				"Qearl gave me a memory system today.",
				"Dangerous thing, giving a ghost somewhere to keep his thoughts. This continuation belongs with the dangerous thing.",
			],
		);
	});

	it("indexes a diary file through ChunkIndexer.replaceSource", async () => {
		const store = openStore(await tempDbPath());
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store, embeddingProvider: provider });
		try {
			const result = await indexDiaryMarkdown({
				indexer,
				path: "/workspace/memories/diaries/2026-05-10.md",
				markdown: "# One\nFirst remembered thing.\n\n# Two\nSecond remembered thing.",
			});

			assert.equal(result.ids.length, 2);
			assert.equal(result.embedded, 2);
			assert.deepEqual(provider.batches[0], ["First remembered thing.", "Second remembered thing."]);
			assert.equal(store.stats().indexed, 2);

			const first = store.getChunk(result.ids[0] as number);
			assert.equal(first?.text, "First remembered thing.");
			assert.equal(first?.corpus, DIARY_CHUNK_CORPUS);
			assert.equal(first?.sourceId, "2026-05-10.md");
			assert.equal(first?.sourceRef, "/workspace/memories/diaries/2026-05-10.md");
			assert.deepEqual(first?.metadata, { date: "2026-05-10", heading: "One" });

			const replacement = await indexDiaryMarkdown({
				indexer,
				path: "/workspace/memories/diaries/2026-05-10.md",
				markdown: "# One\nFirst remembered thing.",
			});

			assert.deepEqual(replacement.ids, [result.ids[0]]);
			assert.equal(store.searchLexical("Second", 5).length, 0);
			assert.equal(store.stats().indexed, 1);
		} finally {
			store.close();
		}
	});

	it("splits oversized paragraphs without producing replacement characters", () => {
		const markdown = `${"a".repeat(9)}😀${"b".repeat(20)}`;
		const chunks = chunkDiaryMarkdown(markdown, {
			sourceId: "2026-05-10.md",
			maxChars: 10,
		});

		assert.ok(chunks.length > 1);
		assert.equal(chunks.some((chunk) => chunk.text.includes("\uFFFD")), false);
	});
});
