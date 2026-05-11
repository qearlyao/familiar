import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { ChatLogRecord } from "../src/chat-log.js";
import { ChunkIndexer } from "../src/memory/index/chunk-indexer.js";
import type { EmbeddingInput, EmbeddingProvider } from "../src/memory/index/embedding-provider.js";
import { MemoryIndexStore } from "../src/memory/index/store.js";
import {
	indexLcmRecords,
	indexLcmSummaries,
	LCM_RECORD_CORPUS,
	LCM_SUMMARY_CORPUS,
	projectNormalizedLcmBatch,
} from "../src/memory/lcm/indexer.js";
import { normalizeChatRecords } from "../src/memory/lcm/normalize.js";
import { LcmStore, lcmRecordIndexSourceId, lcmSummaryIndexSourceId } from "../src/memory/lcm/store.js";

const base = {
	ts: "2026-05-10T01:00:00.000Z",
	service: "web",
	scope: "web",
	channelId: "room",
} as const;

async function tempDbPath(name: string, file: string): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), name));
	return resolve(dir, file);
}

function openMemoryStore(path: string, dimensions = 3): MemoryIndexStore {
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
		return inputs.map((input) => this.vectorFor(input));
	}

	async embedOne(input: EmbeddingInput): Promise<Float32Array> {
		const [embedding] = await this.embed([input]);
		if (!embedding) throw new Error("missing embedding");
		return embedding;
	}

	private vectorFor(input: EmbeddingInput): Float32Array {
		const text = typeof input === "string" ? input : input.parts.map((part) => ("text" in part ? part.text : "")).join("");
		return new Float32Array([text.length, text.length + 1, text.length + 2]);
	}
}

describe("LCM indexer", () => {
	it("projects normalized chat records into LcmStore and MemoryIndexStore while skipping noisy records", async () => {
		const lcmStore = new LcmStore({ path: await tempDbPath("familiar-lcm-indexer-", "lcm.sqlite") });
		const memoryStore = openMemoryStore(await tempDbPath("familiar-lcm-indexer-memory-", "memory.sqlite"));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store: memoryStore, embeddingProvider: provider });
		try {
			const records: ChatLogRecord[] = [
				{
					...base,
					type: "inbound",
					recordId: 1,
					messageId: "m1",
					authorId: "u1",
					text: "Please remember the compact toolbar.",
					isBot: false,
					mentionedBot: false,
					attachments: [],
				},
				{
					...base,
					type: "job_queued",
					recordId: 2,
					jobId: "job-1",
					trigger: "message",
					triggerRecordId: 1,
				},
				{
					...base,
					type: "agent_event",
					recordId: 3,
					jobId: "job-1",
					messageId: "event-1",
					event: { type: "turn_start" },
				},
				{
					...base,
					type: "outbound",
					recordId: 4,
					messageIds: ["m2"],
					text: "I will keep the toolbar preference in view.",
					jobId: "job-1",
				},
				{
					...base,
					type: "checkpoint",
					recordId: 5,
					cursor: "cursor",
				},
				{
					...base,
					type: "outbound",
					recordId: 6,
					messageIds: ["m3"],
					text: "silent control ack",
					silent: true,
				},
			];

			const batch = normalizeChatRecords(records, {
				segmentId: "seg-a",
				sessionId: "session-a",
				channelKey: "web-web-room",
				sourcePath: "data/chat/web-web-room/2026-05-10.jsonl",
			});
			const result = await projectNormalizedLcmBatch({ batch, lcmStore, indexer });

			assert.deepEqual(result.segmentIds, ["seg-a"]);
			assert.equal(result.recordIds.length, 2);
			assert.equal(result.recordIndex.ids.length, 2);
			assert.equal(result.recordIndex.embedded, 2);
			assert.deepEqual(provider.batches[0], [
				"Please remember the compact toolbar.",
				"I will keep the toolbar preference in view.",
			]);

			const storedRecords = lcmStore.listRecords();
			assert.deepEqual(
				storedRecords.map((record) => ({ kind: record.kind, text: record.text, sourceRecordId: record.source.sourceRecordId })),
				[
					{ kind: "user", text: "Please remember the compact toolbar.", sourceRecordId: "1" },
					{ kind: "assistant", text: "I will keep the toolbar preference in view.", sourceRecordId: "4" },
				],
			);

			const chunks = memoryStore.searchLexical("toolbar", { corpus: LCM_RECORD_CORPUS, limit: 10 });
			assert.equal(chunks.length, 2);
			assert.deepEqual(
				chunks.map((hit) => hit.chunk.sourceId).sort(),
				storedRecords.map((record) => lcmRecordIndexSourceId(record.id)).sort(),
			);
			assert.equal(memoryStore.searchLexical("queued", { corpus: LCM_RECORD_CORPUS, limit: 10 }).length, 0);
			assert.equal(memoryStore.stats().indexed, 2);
		} finally {
			lcmStore.close();
			memoryStore.close();
		}
	});

	it("indexes ready summaries with LCM summary source ids and skips placeholders", async () => {
		const lcmStore = new LcmStore({ path: await tempDbPath("familiar-lcm-summary-indexer-", "lcm.sqlite") });
		const memoryStore = openMemoryStore(await tempDbPath("familiar-lcm-summary-indexer-memory-", "memory.sqlite"));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store: memoryStore, embeddingProvider: provider });
		try {
			const readyId = lcmStore.insertSummary({
				segmentId: "seg-a",
				depth: 1,
				text: "The user prefers compact toolbar controls.",
				status: "ready",
				source: { sourceType: "manual", sourceRef: "summary:ready" },
			});
			const placeholderId = lcmStore.insertSummary({
				segmentId: "seg-a",
				depth: 2,
				source: { sourceType: "manual", sourceRef: "summary:placeholder" },
			});

			const result = await indexLcmSummaries({ indexer, summaries: lcmStore.listSummaries() });

			assert.deepEqual(result.ids.length, 1);
			assert.equal(result.embedded, 1);
			const hits = memoryStore.searchLexical("compact", { corpus: LCM_SUMMARY_CORPUS, limit: 10 });
			assert.equal(hits.length, 1);
			assert.equal(hits[0]?.chunk.sourceId, lcmSummaryIndexSourceId(readyId));
			assert.equal(hits[0]?.chunk.metadata?.depth, 1);
			assert.equal(memoryStore.searchLexical("placeholder", { corpus: LCM_SUMMARY_CORPUS, limit: 10 }).length, 0);
			assert.ok(lcmStore.getSummary(placeholderId));
		} finally {
			lcmStore.close();
			memoryStore.close();
		}
	});

	it("indexes LCM record and summary event-time metadata for recall filters", async () => {
		const lcmStore = new LcmStore({ path: await tempDbPath("familiar-lcm-time-indexer-", "lcm.sqlite") });
		const memoryStore = openMemoryStore(await tempDbPath("familiar-lcm-time-indexer-memory-", "memory.sqlite"));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store: memoryStore, embeddingProvider: provider });
		try {
			const first = lcmStore.insertRecord({
				segmentId: "seg-time",
				kind: "user",
				text: "first timed record",
				happenedAt: "2026-05-10T01:00:00.000Z",
				source: { sourceType: "manual", sourceRef: "record:first" },
			});
			const second = lcmStore.insertRecord({
				segmentId: "seg-time",
				kind: "assistant",
				text: "second timed record",
				happenedAt: "2026-05-10T01:05:00.000Z",
				source: { sourceType: "manual", sourceRef: "record:second" },
			});
			const summaryId = lcmStore.insertSummary({
				segmentId: "seg-time",
				depth: 1,
				status: "ready",
				text: "timed coverage summary",
				coversFromRecordId: first,
				coversToRecordId: second,
				source: { sourceType: "manual", sourceRef: "summary:timed" },
				metadata: {
					coverageFromHappenedAt: "2026-05-10T01:00:00.000Z",
					coverageToHappenedAt: "2026-05-10T01:05:00.000Z",
					timestamp: "2026-05-10T01:05:00.000Z",
				},
			});

			const firstRecord = lcmStore.getRecord(first);
			assert.ok(firstRecord);
			await indexLcmRecords({ indexer, records: [firstRecord] });
			const summary = lcmStore.getSummary(summaryId);
			assert.ok(summary);
			await indexLcmSummaries({ indexer, summaries: [summary] });

			const summaryHit = memoryStore.searchLexical("coverage", { corpus: LCM_SUMMARY_CORPUS, limit: 10 })[0];
			assert.equal(summaryHit?.chunk.metadata?.coverageFromHappenedAt, "2026-05-10T01:00:00.000Z");
			assert.equal(summaryHit?.chunk.metadata?.coverageToHappenedAt, "2026-05-10T01:05:00.000Z");
			assert.equal(summaryHit?.chunk.metadata?.timestamp, "2026-05-10T01:05:00.000Z");
			const recordHit = memoryStore.searchLexical("first", { corpus: LCM_RECORD_CORPUS, limit: 10 })[0];
			assert.equal(recordHit?.chunk.sourceId, lcmRecordIndexSourceId(first));
			assert.equal(recordHit?.chunk.metadata?.timestamp, "2026-05-10T01:00:00.000Z");
			assert.equal(recordHit?.chunk.metadata?.happenedAt, "2026-05-10T01:00:00.000Z");
		} finally {
			lcmStore.close();
			memoryStore.close();
		}
	});
});
