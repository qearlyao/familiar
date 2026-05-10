import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { createMemoryTools } from "../src/memory/tools.js";
import { __memoryToolsTest } from "../src/memory/tools.js";
import { MemoryIndexStore } from "../src/memory/index/store.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

async function memoryConfig() {
	const dataDir = await createTempDataDir();
	const memoryRootDir = await mkdtemp(resolve(tmpdir(), "familiar-memory-tools-"));
	return configWithDataDir(dataDir, {
		memory: {
			rootDir: memoryRootDir,
			indexDir: resolve(memoryRootDir, "index"),
			lcmDir: resolve(memoryRootDir, "lcm"),
			diariesDir: resolve(memoryRootDir, "diaries"),
			archiveDir: resolve(memoryRootDir, "archive"),
			embedding: {
				api: "gemini",
				provider: "google",
				model: "gemini-embedding-test",
				baseUrl: "https://embedding.test",
				apiKeyEnv: "",
				dimensions: 3,
				batchSize: 8,
			},
		},
	});
}

function vector(values: number[]): Float32Array {
	return new Float32Array(values);
}

async function withEmbeddingFetch<T>(values: number[], run: () => Promise<T>): Promise<T> {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				embeddings: [{ values }],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		)) as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = previousFetch;
	}
}

describe("memory tools", () => {
	it("creates memory-prefixed recall and open tools", async () => {
		const tools = createMemoryTools(await memoryConfig());

		assert.deepEqual(
			tools.map((tool) => tool.name),
			["memory_recall", "memory_open"],
		);
		assert.equal(tools[0]?.parameters.type, "object");
		assert.equal(tools[1]?.parameters.type, "object");
	});

	it("recalls scoped memory chunks through the shared index", async () => {
		const config = await memoryConfig();
		const store = MemoryIndexStore.open(config);
		try {
			store.insertChunks([
				{
					corpus: "diary_chunk",
					sourceId: "2026-05-10.md",
					sourceRef: "memories/diaries/2026-05-10.md",
					chunkIndex: 0,
					text: "The blue lantern felt tender and close.",
					metadata: { valence: 0.8 },
					embedding: vector([1, 0, 0]),
				},
				{
					corpus: "lcm_record",
					sourceId: "lcm_record:7",
					text: "We discussed database migrations and indexes.",
					metadata: { channelKey: "dm" },
					embedding: vector([0, 1, 0]),
				},
				{
					corpus: "atomic_fact",
					sourceId: "fact:tea",
					text: "The user prefers jasmine tea.",
					metadata: { confidence: "high" },
					embedding: vector([0, 0, 1]),
				},
			]);
		} finally {
			store.close();
		}

		const recall = createMemoryTools(config).find((tool) => tool.name === "memory_recall");
		assert.ok(recall);

		await withEmbeddingFetch([1, 0, 0], async () => {
			const diaryResult = await recall.execute("call-1", {
				query: "blue lantern",
				scope: "diary",
				limit: 5,
			});

			assert.match(diaryResult.content[0]?.type === "text" ? diaryResult.content[0].text : "", /corpus=diary_chunk/);
			assert.match(diaryResult.content[0]?.type === "text" ? diaryResult.content[0].text : "", /blue lantern/);
			assert.doesNotMatch(
				diaryResult.content[0]?.type === "text" ? diaryResult.content[0].text : "",
				/corpus=lcm_record/,
			);
			assert.deepEqual(diaryResult.details.scope, "diary");
			assert.deepEqual(diaryResult.details.ids.length, 1);
		});

		await withEmbeddingFetch([0, 1, 0], async () => {
			const factualResult = await recall.execute("call-2", {
				query: "database migrations",
				scope: "factual",
				limit: 5,
			});

			const text = factualResult.content[0]?.type === "text" ? factualResult.content[0].text : "";
			assert.match(text, /corpus=lcm_record/);
			assert.doesNotMatch(text, /corpus=diary_chunk/);
			assert.deepEqual(factualResult.details.scope, "factual");
		});
	});

	it("opens a chunk with full text and metadata", async () => {
		const config = await memoryConfig();
		const store = MemoryIndexStore.open(config);
		let id: number;
		try {
			id = store.insertChunk({
				corpus: "lcm_summary",
				sourceId: "lcm_summary:3",
				sourceRef: "summary-ref",
				chunkIndex: 2,
				text: "Full summary text with enough detail to prove memory_open does not return only a snippet.",
				snippet: "Full summary text",
				metadata: { depth: 1, segmentId: "seg-1" },
				embedding: vector([0, 1, 0]),
			});
		} finally {
			store.close();
		}

		const open = createMemoryTools(config).find((tool) => tool.name === "memory_open");
		assert.ok(open);

		const result = await open.execute("call-3", { id });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(text, new RegExp(`id=${id} corpus=lcm_summary`));
		assert.match(text, /Full summary text with enough detail/);
		assert.match(text, /metadata: {"depth":1,"segmentId":"seg-1"}/);
		assert.doesNotMatch(text, /1970-/);
		assert.deepEqual(result.details, {
			id,
			found: true,
			corpus: "lcm_summary",
			sourceId: "lcm_summary:3",
			sourceRef: "summary-ref",
			chunkIndex: 2,
		});
	});

	it("reports missing chunks without throwing", async () => {
		const open = createMemoryTools(await memoryConfig()).find((tool) => tool.name === "memory_open");
		assert.ok(open);

		const result = await open.execute("call-4", { id: 404 });

		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /No memory chunk found/);
		assert.deepEqual(result.details, { id: 404, found: false });
	});

	it("formats sqlite unixepoch timestamps as real ISO timestamps", () => {
		const seconds = Date.parse("2026-05-20T00:00:00.000Z") / 1000;
		assert.equal(__memoryToolsTest.formatUnixTimestamp(seconds), "2026-05-20T00:00:00.000Z");
	});
});
