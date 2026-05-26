import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { createMemoryTools } from "../src/memory/tools.js";
import { __memoryToolsTest } from "../src/memory/tools.js";
import type { EmbeddingProvider, EmbeddingInput } from "../src/memory/index/embedding-provider.js";
import { MemoryIndexStore } from "../src/memory/index/store.js";
import { createMemoryService } from "../src/memory/service.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

async function memoryConfig(t: { after(fn: () => Promise<void>): void }) {
	const dataDir = await createTempDataDir();
	const memoryRootDir = await mkdtemp(resolve(tmpdir(), "familiar-memory-tools-"));
	t.after(async () => {
		await Promise.all([
			rm(dataDir, { recursive: true, force: true }),
			rm(memoryRootDir, { recursive: true, force: true }),
		]);
	});
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

class FakeEmbeddingProvider implements EmbeddingProvider {
	readonly api = "fake";
	readonly provider = "fake";
	readonly model = "fake";
	readonly dimensions = 3;
	readonly inputs: EmbeddingInput[] = [];
	constructor(private readonly values: number[]) {}
	async embed(inputs: EmbeddingInput[], _signal?: AbortSignal): Promise<Float32Array[]> {
		this.inputs.push(...inputs);
		return inputs.map(() => vector(this.values));
	}
	async embedOne(input: EmbeddingInput, signal?: AbortSignal): Promise<Float32Array> {
		const [embedding] = await this.embed([input], signal);
		return embedding as Float32Array;
	}
}

function createTools(store: MemoryIndexStore, values = [1, 0, 0]) {
	return createMemoryTools({ store, embeddingProvider: new FakeEmbeddingProvider(values) });
}

describe("memory tools", () => {
	it("creates memory-prefixed recall and open tools", async (t) => {
		const config = await memoryConfig(t);
		const store = MemoryIndexStore.open(config);
		try {
			const tools = createTools(store);

			assert.deepEqual(
				tools.map((tool) => tool.name),
				["memory_recall", "memory_open"],
			);
			assert.equal(tools[0]?.parameters.type, "object");
			assert.equal(tools[1]?.parameters.type, "object");
		} finally {
			store.close();
		}
	});

	it("recalls scoped memory chunks through the shared index", async (t) => {
		const config = await memoryConfig(t);
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

			const recall = createTools(store, [1, 0, 0]).find((tool) => tool.name === "memory_recall");
			assert.ok(recall);

			const diaryResult = await recall.execute("call-1", {
				query: "blue lantern",
				scope: "diary",
				limit: 5,
			});

			assert.match(diaryResult.content[0]?.type === "text" ? diaryResult.content[0].text : "", /type=diary/);
			assert.match(diaryResult.content[0]?.type === "text" ? diaryResult.content[0].text : "", /blue lantern/);
			assert.doesNotMatch(
				diaryResult.content[0]?.type === "text" ? diaryResult.content[0].text : "",
				/type=conversation/,
			);
			assert.doesNotMatch(diaryResult.content[0]?.type === "text" ? diaryResult.content[0].text : "", /metadata:/);
			assert.deepEqual(Object.keys(diaryResult.details).sort(), ["ids", "resultCount"]);
			assert.equal(diaryResult.details.resultCount, 1);
			assert.equal(diaryResult.details.ids.length, 1);

			const factualRecall = createTools(store, [0, 1, 0]).find((tool) => tool.name === "memory_recall");
			assert.ok(factualRecall);
				const factualResult = await factualRecall.execute("call-2", {
					query: "database migrations",
					scope: "factual",
					limit: 5,
				});

				const text = factualResult.content[0]?.type === "text" ? factualResult.content[0].text : "";
				assert.match(text, /type=conversation/);
				assert.doesNotMatch(text, /type=diary/);
				assert.doesNotMatch(text, /metadata:/);
				assert.doesNotMatch(text, /source=/);
				assert.deepEqual(Object.keys(factualResult.details).sort(), ["ids", "resultCount"]);
				assert.equal(factualResult.details.resultCount, factualResult.details.ids.length);
		} finally {
			store.close();
		}
	});

	it("defaults memory_recall scope to all and supports mode plus time filters", async (t) => {
		const config = await memoryConfig(t);
		const store = MemoryIndexStore.open(config);
		try {
			store.insertChunks([
				{
					corpus: "diary_chunk",
					sourceId: "2026-05-10.md",
					text: "timeline marker from private diary",
					metadata: { timestamp: "2026-05-10T03:00:00.000Z" },
					embedding: vector([1, 0, 0]),
				},
				{
					corpus: "lcm_record",
					sourceId: "lcm_record:1",
					text: "timeline marker from early chat",
					metadata: { timestamp: "2026-05-10T01:00:00.000Z" },
					embedding: vector([1, 0, 0]),
				},
				{
					corpus: "atomic_fact",
					sourceId: "fact:2",
					text: "timeline marker from later fact",
					metadata: { timestamp: "2026-05-10T03:00:00.000Z" },
					embedding: vector([1, 0, 0]),
				},
			]);

			const recall = createTools(store).find((tool) => tool.name === "memory_recall");
			assert.ok(recall);
			const result = await recall.execute("call-time", {
				query: "timeline marker",
				mode: "lexical",
				after: "2026-05-10T02:00:00.000Z",
				limit: 5,
			});
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";

			assert.deepEqual(Object.keys(result.details).sort(), ["ids", "resultCount"]);
			assert.equal(result.details.resultCount, 2);
			assert.match(text, /type=fact/);
			assert.match(text, /type=diary/);
			assert.match(text, /private diary/);
			assert.doesNotMatch(text, /early chat/);
		} finally {
			store.close();
		}
	});

	it("opens a chunk with full text and metadata", async (t) => {
		const config = await memoryConfig(t);
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
				metadata: {
					depth: 1,
					segmentId: "seg-1",
					timestamp: "2026-05-10T01:00:00.000Z",
					source: { sourceRef: "summary-ref" },
				},
				embedding: vector([0, 1, 0]),
			});

				const open = createTools(store).find((tool) => tool.name === "memory_open");
				assert.ok(open);

				const result = await open.execute("call-3", { id });
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				assert.match(text, new RegExp(`id=${id} type=conversation_summary`));
				assert.match(text, /when=2026-05-10T01:00:00.000Z/);
				assert.match(text, /sources=summary-ref/);
			assert.match(text, /Full summary text with enough detail/);
			assert.doesNotMatch(text, /metadata:/);
			assert.doesNotMatch(text, /1970-/);
			assert.deepEqual(result.details, {
				id,
				found: true,
				corpus: "lcm_summary",
				sourceId: "lcm_summary:3",
				sourceRef: "summary-ref",
				chunkIndex: 2,
				sources: [{ corpus: "lcm_summary", sourceId: "lcm_summary:3", sourceRef: "summary-ref", chunkIndex: 2 }],
			});
		} finally {
			store.close();
		}
	});

	it("reports missing chunks without throwing", async (t) => {
		const config = await memoryConfig(t);
		const store = MemoryIndexStore.open(config);
		try {
			const open = createTools(store).find((tool) => tool.name === "memory_open");
			assert.ok(open);

			const result = await open.execute("call-4", { id: 404 });

			assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /No memory chunk found/);
			assert.deepEqual(result.details, { id: 404, found: false });
		} finally {
			store.close();
		}
	});

	it("MemoryService reuses one memory store across repeated recall tool calls", async (t) => {
		const config = await memoryConfig(t);
		const service = createMemoryService(config);
		try {
			const store = serviceMemoryStore(service);
			store.insertChunk({
				corpus: "lcm_record",
				sourceId: "lcm_record:1",
				text: "shared store marker",
				embedding: vector([1, 0, 0]),
			});
			const recall = service.memoryTools().find((tool) => tool.name === "memory_recall");
			assert.ok(recall);

			await recall.execute("call-a", { query: "shared", mode: "lexical" });
			await recall.execute("call-b", { query: "shared", mode: "lexical" });
			await recall.execute("call-c", { query: "shared", mode: "lexical" });

			assert.equal(serviceMemoryStore(service), store);
		} finally {
			service.close();
		}
	});

	it("formats sqlite unixepoch timestamps as real ISO timestamps", () => {
		const seconds = Date.parse("2026-05-20T00:00:00.000Z") / 1000;
		assert.equal(__memoryToolsTest.formatUnixTimestamp(seconds), "2026-05-20T00:00:00.000Z");
	});
});

function serviceMemoryStore(service: ReturnType<typeof createMemoryService>): MemoryIndexStore {
	return (service as unknown as { memoryStore: MemoryIndexStore }).memoryStore;
}
