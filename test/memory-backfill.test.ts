import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { ChatLogRecord } from "../src/chat-log.js";
import { ChunkIndexer } from "../src/memory/index/chunk-indexer.js";
import type { EmbeddingInput, EmbeddingProvider } from "../src/memory/index/embedding-provider.js";
import { MemoryIndexStore } from "../src/memory/index/store.js";
import { backfillFromChatLogs } from "../src/memory/lcm/backfill.js";
import { LCM_RECORD_CORPUS } from "../src/memory/lcm/indexer.js";
import { LcmStore } from "../src/memory/lcm/store.js";
import { configWithDataDir } from "./helpers.js";

const base = {
	ts: "2026-05-01T01:00:00.000Z",
	service: "web",
	scope: "web",
	channelId: "test-channel",
} as const;

class FakeEmbeddingProvider implements EmbeddingProvider {
	readonly api = "fake";
	readonly provider = "fake";
	readonly model = "fake-embedding";
	readonly dimensions = 3;

	async embed(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
		return inputs.map((input) => {
			const text = typeof input === "string" ? input : input.parts.map((part) => ("text" in part ? part.text : "")).join("");
			return new Float32Array([text.length, text.length + 1, text.length + 2]);
		});
	}

	async embedOne(input: EmbeddingInput): Promise<Float32Array> {
		const [embedding] = await this.embed([input]);
		if (!embedding) throw new Error("missing embedding");
		return embedding;
	}
}

async function tempDir(prefix: string): Promise<string> {
	return mkdtemp(resolve(tmpdir(), prefix));
}

async function createHarness(t: { after(fn: () => Promise<void>): void }) {
	const dataDir = await tempDir("familiar-backfill-data-");
	const memoryDir = await tempDir("familiar-backfill-memory-");
	t.after(async () => {
		await Promise.all([
			rm(dataDir, { recursive: true, force: true }),
			rm(memoryDir, { recursive: true, force: true }),
		]);
	});
	const config = await configWithDataDir(dataDir, {
		memory: {
			rootDir: memoryDir,
			indexDir: resolve(memoryDir, "index"),
			lcmDir: resolve(memoryDir, "lcm"),
			diariesDir: resolve(memoryDir, "diaries"),
			archiveDir: resolve(memoryDir, "archive"),
			embedding: {
				api: "gemini",
				provider: "fake",
				model: "fake-embedding",
				baseUrl: "https://embedding.test",
				apiKeyEnv: "",
				dimensions: 3,
				batchSize: 32,
			},
		},
	});
	const lcmStore = LcmStore.open(config);
	const memoryStore = MemoryIndexStore.open(config);
	const embeddingProvider = new FakeEmbeddingProvider();
	const indexer = new ChunkIndexer({ store: memoryStore, embeddingProvider });
	return {
		dataDir,
		config,
		lcmStore,
		memoryStore,
		embeddingProvider,
		indexer,
		async close() {
			memoryStore.close();
			lcmStore.close();
		},
	};
}

function inbound(recordId: number, text = `inbound ${recordId}`, ts = `2026-05-01T01:00:0${recordId}.000Z`): ChatLogRecord {
	return {
		...base,
		ts,
		type: "inbound",
		recordId,
		messageId: `m${recordId}`,
		authorId: "u1",
		text,
		isBot: false,
		mentionedBot: false,
		attachments: [],
	};
}

function outbound(recordId: number, text = `outbound ${recordId}`, ts = `2026-05-01T01:00:0${recordId}.000Z`): ChatLogRecord {
	return {
		...base,
		ts,
		type: "outbound",
		recordId,
		messageIds: [`m${recordId}`],
		text,
		jobId: `job-${recordId}`,
	};
}

function controlNew(recordId: number): ChatLogRecord {
	return {
		...base,
		ts: "2026-05-01T01:00:05.500Z",
		type: "control",
		recordId,
		command: "new",
		authorId: "u1",
		text: "/new",
	};
}

async function writeChatFile(dataDir: string, channelKey: string, date: string, records: ChatLogRecord[]): Promise<void> {
	const dir = resolve(dataDir, "chat", channelKey);
	await mkdir(dir, { recursive: true });
	await writeFile(resolve(dir, `${date}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n"), "utf8");
}

async function runBackfill(harness: Awaited<ReturnType<typeof createHarness>>, options = {}) {
	return backfillFromChatLogs(
		{
			lcmStore: harness.lcmStore,
			memoryStore: harness.memoryStore,
			indexer: harness.indexer,
			embeddingProvider: harness.embeddingProvider,
			config: harness.config,
		},
		{ dataDir: harness.dataDir, ...options },
	);
}

describe("memory LCM backfill", () => {
	it("returns a zero report for an empty data directory", async (t) => {
		const harness = await createHarness(t);
		try {
			const report = await runBackfill(harness);
			assert.deepEqual(report, {
				chatFilesProcessed: 0,
				transcriptFilesProcessed: 0,
				recordsInserted: 0,
				recordsSkippedDuplicate: 0,
				segmentsCreated: 0,
				summariesInserted: 0,
				indexedChunks: 0,
				errors: [],
			});
		} finally {
			await harness.close();
		}
	});

	it("ingests basic chat records into LCM and indexes chunks", async (t) => {
		const harness = await createHarness(t);
		try {
			await writeChatFile(
				harness.dataDir,
				"test-channel",
				"2026-05-01",
				Array.from({ length: 5 }, (_, index) => [inbound(index * 2 + 1), outbound(index * 2 + 2)]).flat(),
			);

			const report = await runBackfill(harness);

			assert.equal(report.recordsInserted, 10);
			assert.equal(harness.lcmStore.listRecords().length, 10);
			assert.equal(harness.lcmStore.listSegments().length, 1);
			assert.equal(harness.memoryStore.searchLexical("inbound", { corpus: LCM_RECORD_CORPUS, limit: 20 }).length, 5);
			assert.equal(report.indexedChunks, 10);
		} finally {
			await harness.close();
		}
	});

	it("is idempotent on repeated runs", async (t) => {
		const harness = await createHarness(t);
		try {
			await writeChatFile(harness.dataDir, "test-channel", "2026-05-01", [inbound(1), outbound(2)]);
			const first = await runBackfill(harness);
			const second = await runBackfill(harness);

			assert.equal(first.recordsInserted, 2);
			assert.equal(second.recordsInserted, 0);
			assert.equal(second.recordsSkippedDuplicate, 2);
			assert.equal(harness.lcmStore.listRecords().length, 2);
			const duplicateKeys = harness.lcmStore.db
				.prepare("SELECT record_key, COUNT(*) AS n FROM lcm_records GROUP BY record_key HAVING n > 1")
				.all();
			assert.deepEqual(duplicateKeys, []);
		} finally {
			await harness.close();
		}
	});

	it("keeps distinct records with matching source coordinates but different text", async (t) => {
		const harness = await createHarness(t);
		try {
			await writeChatFile(harness.dataDir, "test-channel", "2026-05-01", [
				inbound(1, "first distinct text", "2026-05-01T01:00:01.000Z"),
				inbound(1, "second distinct text", "2026-05-01T01:00:01.000Z"),
			]);

			const first = await runBackfill(harness);
			const second = await runBackfill(harness);

			assert.equal(first.recordsInserted, 2);
			assert.equal(second.recordsInserted, 0);
			assert.equal(second.recordsSkippedDuplicate, 2);
			assert.equal(harness.lcmStore.listRecords().length, 2);
		} finally {
			await harness.close();
		}
	});

	it("splits segments on control new boundaries", async (t) => {
		const harness = await createHarness(t);
		try {
			await writeChatFile(harness.dataDir, "test-channel", "2026-05-01", [
				inbound(1),
				outbound(2),
				controlNew(3),
				inbound(4, "after reset", "2026-05-01T01:00:06.000Z"),
			]);

			const report = await runBackfill(harness);

			assert.equal(report.segmentsCreated, 2);
			assert.equal(harness.lcmStore.listSegments().length, 2);
			assert.equal(harness.lcmStore.listRecords().length, 4);
		} finally {
			await harness.close();
		}
	});

	it("honors channel filters", async (t) => {
		const harness = await createHarness(t);
		try {
			await writeChatFile(harness.dataDir, "test-channel", "2026-05-01", [inbound(1)]);
			await writeChatFile(harness.dataDir, "other-channel", "2026-05-01", [
				{ ...inbound(2), channelId: "other-channel" },
			]);

			const report = await runBackfill(harness, { channels: ["test-channel"] });

			assert.equal(report.chatFilesProcessed, 1);
			assert.equal(report.recordsInserted, 1);
			assert.deepEqual(
				harness.lcmStore.listRecords().map((record) => record.channelKey),
				["test-channel"],
			);
		} finally {
			await harness.close();
		}
	});

	it("dry-runs without writing LCM rows", async (t) => {
		const harness = await createHarness(t);
		try {
			await writeChatFile(harness.dataDir, "test-channel", "2026-05-01", [inbound(1), outbound(2)]);

			const report = await runBackfill(harness, { dryRun: true });

			assert.equal(report.recordsInserted, 2);
			assert.equal(report.segmentsCreated, 1);
			assert.equal(report.indexedChunks, 0);
			assert.equal(harness.lcmStore.listRecords().length, 0);
			assert.equal(harness.lcmStore.listSegments().length, 0);
		} finally {
			await harness.close();
		}
	});
});
