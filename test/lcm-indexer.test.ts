import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { ChatLogRecord } from "../src/conversation/chat-log.js";
import { ChunkIndexer } from "../src/memory/index/chunk-indexer.js";
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
import type { LcmRecordPart, StoredLcmRecord } from "../src/memory/lcm/types.js";
import { FakeEmbeddingProvider } from "./memory-fakes.js";

const base = {
	ts: "2026-05-10T01:00:00.000Z",
	service: "web",
	scope: "web",
	channelId: "room",
} as const;

async function tempDbPath(t: { after(fn: () => Promise<void>): void }, name: string, file: string): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), name));
	t.after(() => rm(dir, { recursive: true, force: true }));
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

function storedRecord(input: {
	id: number;
	kind: StoredLcmRecord["kind"];
	text: string;
	parts?: LcmRecordPart[] | null;
}): StoredLcmRecord {
	return {
		id: input.id,
		recordKey: `record-${input.id}`,
		segmentId: "seg-a",
		kind: input.kind,
		text: input.text,
		parts: input.parts ?? null,
		happenedAt: "2026-05-09T05:07:22.802Z",
		sessionId: "session-a",
		channelKey: "dm",
		channelId: "room",
		jobId: null,
		source: { sourceType: "chat", sourceRef: `chat.jsonl#${input.id}` },
		attachments: null,
		metadata: null,
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("LCM indexer", () => {
	it("projects normalized chat records into LcmStore and MemoryIndexStore while skipping noisy records", async (t) => {
		const lcmStore = new LcmStore({ path: await tempDbPath(t, "familiar-lcm-indexer-", "lcm.sqlite") });
		const memoryStore = openMemoryStore(await tempDbPath(t, "familiar-lcm-indexer-memory-", "memory.sqlite"));
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

	it("indexes ready summaries with LCM summary source ids and skips placeholders", async (t) => {
		const lcmStore = new LcmStore({ path: await tempDbPath(t, "familiar-lcm-summary-indexer-", "lcm.sqlite") });
		const memoryStore = openMemoryStore(await tempDbPath(t, "familiar-lcm-summary-indexer-memory-", "memory.sqlite"));
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

	it("indexes only memory-facing visible text from noisy LCM records", async (t) => {
		const memoryStore = openMemoryStore(await tempDbPath(t, "familiar-lcm-visible-indexer-memory-", "memory.sqlite"));
		const provider = new FakeEmbeddingProvider();
		const indexer = new ChunkIndexer({ store: memoryStore, embeddingProvider: provider });
		try {
			const userRecord = storedRecord({
				id: 1,
				kind: "user",
				text: "noooo, it's called Stargazy pie",
			});
			const visibleAssistant = storedRecord({
				id: 2,
				kind: "assistant",
				text:
					"[thinking] planning the search\n" +
					"[tool_call: web_search({\"query\":\"Stargazy pie\"})]\n" +
					"Stargazy pie is Cornish and tied to Mousehole.",
				parts: [
					{ kind: "thinking" as const, text: "planning the search" },
					{
						kind: "tool_call" as const,
						toolCallId: "call-1",
						toolName: "web_search",
						arguments: { query: "Stargazy pie" },
					},
					{ kind: "text" as const, text: "Stargazy pie is Cornish and tied to Mousehole." },
				],
			});
			const planningOnlyAssistant = storedRecord({
				id: 3,
				kind: "assistant",
				text: "[thinking] only internal planning\n[tool_call: web_search({\"query\":\"Stargazy pie\"})]",
				parts: [
					{ kind: "thinking" as const, text: "only internal planning" },
					{
						kind: "tool_call" as const,
						toolCallId: "call-2",
						toolName: "web_search",
						arguments: { query: "Stargazy pie" },
					},
				],
			});
			const toolResult = storedRecord({
				id: 4,
				kind: "tool",
				text: "[tool_result: web_search -> raw result json about Stargazy pie]",
				parts: [
					{
						kind: "tool_result" as const,
						toolCallId: "call-2",
						toolName: "web_search",
						output: { text: "raw result json about Stargazy pie" },
					},
				],
			});
			const doubledLegacy = storedRecord({
				id: 5,
				kind: "assistant",
				text:
					"fish pie, you mean? yeah, heard of it. bones and regret.\n" +
					"fish pie, you mean? yeah, heard of it. bones and regret.",
			});
			const quotedThinking = storedRecord({
				id: 6,
				kind: "user",
				text: "[thinking] is a literal tag I want to discuss, not an internal block.",
			});

			const result = await indexLcmRecords({
				indexer,
				records: [userRecord, visibleAssistant, planningOnlyAssistant, toolResult, doubledLegacy, quotedThinking],
			});

			assert.equal(result.embedded, 4);
			assert.deepEqual(provider.batches[0], [
				"noooo, it's called Stargazy pie",
				"Stargazy pie is Cornish and tied to Mousehole.",
				"fish pie, you mean? yeah, heard of it. bones and regret.",
				"[thinking] is a literal tag I want to discuss, not an internal block.",
			]);
			assert.equal(memoryStore.searchLexical("Mousehole", { corpus: LCM_RECORD_CORPUS, limit: 10 }).length, 1);
			const fishHit = memoryStore.searchLexical("bones regret", { corpus: LCM_RECORD_CORPUS, limit: 10 })[0];
			assert.equal(fishHit?.chunk.text, "fish pie, you mean? yeah, heard of it. bones and regret.");
			assert.equal(memoryStore.searchLexical("planning", { corpus: LCM_RECORD_CORPUS, limit: 10 }).length, 0);
			assert.equal(memoryStore.searchLexical("tool_call", { corpus: LCM_RECORD_CORPUS, limit: 10 }).length, 0);
			assert.equal(memoryStore.searchLexical("raw result", { corpus: LCM_RECORD_CORPUS, limit: 10 }).length, 0);
			assert.equal(memoryStore.searchLexical("literal tag", { corpus: LCM_RECORD_CORPUS, limit: 10 }).length, 1);
		} finally {
			memoryStore.close();
		}
	});

	it("indexes LCM record and summary event-time metadata for recall filters", async (t) => {
		const lcmStore = new LcmStore({ path: await tempDbPath(t, "familiar-lcm-time-indexer-", "lcm.sqlite") });
		const memoryStore = openMemoryStore(await tempDbPath(t, "familiar-lcm-time-indexer-memory-", "memory.sqlite"));
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
