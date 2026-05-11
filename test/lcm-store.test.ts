import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import Database from "better-sqlite3";

import { LcmStore } from "../src/memory/lcm/store.js";
import type { LcmSourceProvenance } from "../src/memory/lcm/types.js";

async function tempDbPath(): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "familiar-lcm-"));
	return resolve(dir, "memories", "lcm", "lcm.sqlite");
}

function source(id: string | number): LcmSourceProvenance {
	return {
		sourceType: "chat",
		sourcePath: "data/chat/web-web-room/2026-05-10.jsonl",
		sourceRecordId: id,
		sourceRef: `chat:${id}`,
	};
}

async function openStore(): Promise<LcmStore> {
	return new LcmStore({ path: await tempDbPath() });
}

describe("LcmStore", () => {
	it("creates the normalized source DB and round-trips records with provenance", async () => {
		const store = await openStore();
		try {
			assert.equal(store.schemaVersion(), 3);
			store.ensureSegment({
				id: "seg-a",
				sessionId: "session-a",
				channelKey: "web-web-room",
				startedAt: "2026-05-10T01:00:00.000Z",
				boundarySource: source("start"),
				metadata: { reason: "initial" },
			});

			const id = store.insertRecord({
				segmentId: "seg-a",
				kind: "user",
				text: "Can you remember the blue lantern?",
				happenedAt: "2026-05-10T01:01:00.000Z",
				sessionId: "session-a",
				channelKey: "web-web-room",
				channelId: "room",
				source: source(1),
				attachments: [{ id: "att-1", name: "lantern.png", kind: "image", note: "blue lantern on a table" }],
				metadata: { authorName: "Q" },
			});
			const duplicate = store.insertRecord({
				segmentId: "seg-a",
				kind: "user",
				text: "Can you remember the blue lantern?",
				happenedAt: "2026-05-10T01:01:00.000Z",
				sessionId: "session-a",
				channelKey: "web-web-room",
				channelId: "room",
				source: source(1),
			});

			assert.equal(duplicate, id);
			const record = store.getRecord(id);
			assert.equal(record?.text, "Can you remember the blue lantern?");
			assert.equal(record?.source.sourcePath, "data/chat/web-web-room/2026-05-10.jsonl");
			assert.equal(record?.source.sourceRecordId, "1");
			assert.deepEqual(record?.attachments?.[0], {
				id: "att-1",
				name: "lantern.png",
				kind: "image",
				note: "blue lantern on a table",
			});
			assert.equal(store.searchRecordsLexical("lantern").length, 1);
			assert.equal(store.listSegments()[0]?.metadata?.reason, "initial");
		} finally {
			store.close();
		}
	});

	it("round-trips parts_json through insert and getRecord", async () => {
		const store = await openStore();
		try {
			const id = store.insertRecord({
				segmentId: "seg-a",
				kind: "assistant",
				text: "[tool_call: read({\"path\":\"PLAN.md\"})]",
				parts: [{ kind: "tool_call", toolCallId: "call-1", toolName: "read", arguments: { path: "PLAN.md" } }],
				happenedAt: "2026-05-10T01:00:00.000Z",
				source: source(1),
			});

			assert.deepEqual(store.getRecord(id)?.parts, [
				{ kind: "tool_call", toolCallId: "call-1", toolName: "read", arguments: { path: "PLAN.md" } },
			]);
		} finally {
			store.close();
		}
	});

	it("stores summary placeholders and provenance edges", async () => {
		const store = await openStore();
		try {
			const first = store.insertRecord({
				segmentId: "seg-a",
				kind: "user",
				text: "We debugged the memory store.",
				happenedAt: "2026-05-10T01:00:00.000Z",
				source: source(1),
			});
			const second = store.insertRecord({
				segmentId: "seg-a",
				kind: "assistant",
				text: "The schema keeps source provenance.",
				happenedAt: "2026-05-10T01:01:00.000Z",
				source: source(2),
			});

			const summaryId = store.insertSummary({
				segmentId: "seg-a",
				depth: 2,
				source: { sourceType: "manual", sourceRef: "placeholder:d2" },
				sourceItems: [
					{ recordId: first, sourceRef: "chat:1" },
					{ recordId: second, sourceRef: "chat:2", snapshot: { kind: "assistant" } },
				],
			});

			const summary = store.getSummary(summaryId);
			assert.equal(summary?.status, "placeholder");
			assert.equal(summary?.text, "");
			assert.equal(summary?.depth, 2);
			assert.deepEqual(
				store.getSummarySources(summaryId).map((item) => ({
					recordId: item.recordId,
					sourceRef: item.sourceRef,
					snapshot: item.snapshot,
				})),
				[
					{ recordId: first, sourceRef: "chat:1", snapshot: null },
					{ recordId: second, sourceRef: "chat:2", snapshot: { kind: "assistant" } },
				],
			);
		} finally {
			store.close();
		}
	});

	it("sanitizes lexical FTS queries and returns empty operator-only searches", async () => {
		const store = await openStore();
		try {
			const id = store.insertRecord({
				segmentId: "seg-a",
				kind: "user",
				text: "I won't / can't forget this.",
				happenedAt: "2026-05-10T01:00:00.000Z",
				source: source(1),
			});
			store.insertSummary({
				segmentId: "seg-a",
				depth: 1,
				status: "ready",
				text: "The summary says we won't forget this.",
				source: { sourceType: "manual", sourceRef: "summary:1" },
				sourceItems: [{ recordId: id }],
			});

			assert.equal(store.searchRecordsLexical("won't").map((record) => record.id)[0], id);
			assert.equal(store.searchSummariesLexical("won't").length, 1);
			assert.deepEqual(store.searchRecordsLexical(":"), []);
			assert.deepEqual(store.searchRecordsLexical("OR"), []);
		} finally {
			store.close();
		}
	});

	it("removes contentless FTS rows when segment cascade deletes records", async () => {
		const store = await openStore();
		try {
			store.insertRecord({
				segmentId: "seg-a",
				kind: "user",
				text: "cascade-only lexical marker",
				happenedAt: "2026-05-10T01:00:00.000Z",
				source: source(1),
			});
			assert.equal(store.searchRecordsLexical("cascade-only").length, 1);

			store.db.transaction(() => {
				const records = store.listRecords("seg-a");
				for (const record of records) {
					store.db.prepare("DELETE FROM lcm_records_fts WHERE rowid = ?").run(record.id);
				}
				store.db.prepare("DELETE FROM lcm_segments WHERE id = ?").run("seg-a");
			}).immediate();

			assert.equal(store.searchRecordsLexical("cascade-only").length, 0);
		} finally {
			store.close();
		}
	});

	it("keeps contentless FTS rows stable when reopening the store", async () => {
		const path = await tempDbPath();
		let store = new LcmStore({ path });
		try {
			store.insertRecord({
				segmentId: "seg-a",
				kind: "user",
				text: "stable reopen marker",
				happenedAt: "2026-05-10T01:00:00.000Z",
				source: source(1),
			});
			assert.equal(store.searchRecordsLexical("stable").length, 1);
		} finally {
			store.close();
		}

		store = new LcmStore({ path });
		try {
			assert.equal(store.searchRecordsLexical("stable").length, 1);
			assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM lcm_records_fts").get() as { n: number }).n, 1);
		} finally {
			store.close();
		}
	});

	it("rolls back implicit segment creation when record insert fails", async () => {
		const store = await openStore();
		const originalPrepare = store.db.prepare.bind(store.db);
		store.db.prepare = ((sourceSql: string) => {
			if (sourceSql.includes("INSERT INTO lcm_records (")) throw new Error("simulated insert failure");
			return originalPrepare(sourceSql);
		}) as typeof store.db.prepare;
		try {
			assert.throws(
				() =>
					store.insertRecord({
						segmentId: "seg-fail",
						kind: "user",
						text: "this insert fails",
						happenedAt: "2026-05-10T01:00:00.000Z",
						source: source(1),
					}),
				/simulated insert failure/,
			);
			assert.equal(store.getSegment("seg-fail"), null);
		} finally {
			store.db.prepare = originalPrepare as typeof store.db.prepare;
			store.close();
		}
	});

	it("deletes summary source rows when retained summaries are pruned", async () => {
		const store = await storeWithClosedSegments();
		try {
			assert.ok(store.getSummarySources(1).length > 0);

			store.applyNewSessionRetention({ newSessionRetainDepth: 2, activeSegmentId: "seg-c" });

			assert.equal(store.getSummarySources(1).length, 0);
		} finally {
			store.close();
		}
	});

	it("does not index boundary records into lexical FTS", async () => {
		const store = await openStore();
		try {
			store.insertRecord({
				segmentId: "seg-a",
				kind: "boundary",
				text: "",
				happenedAt: "2026-05-10T01:00:00.000Z",
				source: source("boundary"),
			});
			const normal = store.insertRecord({
				segmentId: "seg-a",
				kind: "user",
				text: "Session planning note",
				happenedAt: "2026-05-10T01:01:00.000Z",
				source: source(1),
			});

			assert.deepEqual(
				store.searchRecordsLexical("Session").map((record) => record.id),
				[normal],
			);
		} finally {
			store.close();
		}
	});

	it("enables foreign key enforcement on opened store connections", async () => {
		const path = await tempDbPath();
		await mkdir(resolve(path, ".."), { recursive: true });
		const raw = new Database(path);
		try {
			raw.pragma("foreign_keys = OFF");
		} finally {
			raw.close();
		}

		const store = new LcmStore({ path });
		try {
			assert.equal((store.db.pragma("foreign_keys", { simple: true }) as number), 1);
		} finally {
			store.close();
		}
	});

	it("keeps all context for newSessionRetainDepth -1", async () => {
		const store = await storeWithClosedSegments();
		try {
			const report = store.applyNewSessionRetention({ newSessionRetainDepth: -1, activeSegmentId: "seg-c" });
			assert.equal(report.rawRecordsDeleted, 0);
			assert.equal(report.summariesDeleted, 0);
			assert.equal(store.listRecords().length, 3);
			assert.equal(store.listSummaries().length, 4);
		} finally {
			store.close();
		}
	});

	it("drops raw records but keeps summaries for newSessionRetainDepth 0", async () => {
		const store = await storeWithClosedSegments();
		try {
			const report = store.applyNewSessionRetention({ newSessionRetainDepth: 0, activeSegmentId: "seg-c" });
			assert.equal(report.rawRecordsDeleted, 2);
			assert.equal(report.summariesDeleted, 0);
			assert.deepEqual(
				store.listRecords().map((record) => record.segmentId),
				["seg-c"],
			);
			assert.equal(store.listSummaries().length, 4);
			assert.equal(store.getSummarySources(1)[0]?.recordId, null);
			assert.equal(report.indexDeletes.filter((item) => item.corpus === "lcm_record").length, 2);
		} finally {
			store.close();
		}
	});

	it("keeps only retained-depth or pinned summaries for positive newSessionRetainDepth", async () => {
		const store = await storeWithClosedSegments();
		try {
			const report = store.applyNewSessionRetention({ newSessionRetainDepth: 2, activeSegmentId: "seg-c" });
			assert.equal(report.rawRecordsDeleted, 2);
			assert.equal(report.summariesDeleted, 1);
			assert.deepEqual(
				store.listSummaries().map((summary) => ({
					segmentId: summary.segmentId,
					depth: summary.depth,
					pinned: summary.pinned,
					text: summary.text,
				})),
				[
					{ segmentId: "seg-a", depth: 2, pinned: false, text: "d2 summary" },
					{ segmentId: "seg-b", depth: 1, pinned: true, text: "pinned d1 summary" },
					{ segmentId: "seg-c", depth: 1, pinned: false, text: "active summary" },
				],
			);
			assert.equal(report.indexDeletes.filter((item) => item.corpus === "lcm_summary").length, 1);
		} finally {
			store.close();
		}
	});
});

async function storeWithClosedSegments(): Promise<LcmStore> {
	const store = await openStore();
	store.ensureSegment({ id: "seg-a", startedAt: "2026-05-10T01:00:00.000Z" });
	store.insertRecord({
		segmentId: "seg-a",
		kind: "user",
		text: "first raw",
		happenedAt: "2026-05-10T01:00:00.000Z",
		source: source(1),
	});
	store.insertSummary({
		segmentId: "seg-a",
		depth: 1,
		text: "d1 summary",
		source: { sourceType: "manual", sourceRef: "sum:a1" },
		sourceItems: [{ recordId: 1 }],
	});
	store.insertSummary({
		segmentId: "seg-a",
		depth: 2,
		text: "d2 summary",
		source: { sourceType: "manual", sourceRef: "sum:a2" },
		sourceItems: [{ summaryId: 1 }],
	});
	store.closeSegment("seg-a", "2026-05-10T02:00:00.000Z");

	store.ensureSegment({ id: "seg-b", startedAt: "2026-05-10T03:00:00.000Z" });
	store.insertRecord({
		segmentId: "seg-b",
		kind: "assistant",
		text: "second raw",
		happenedAt: "2026-05-10T03:00:00.000Z",
		source: source(2),
	});
	store.insertSummary({
		segmentId: "seg-b",
		depth: 1,
		text: "pinned d1 summary",
		pinned: true,
		source: { sourceType: "manual", sourceRef: "sum:b1" },
		sourceItems: [{ recordId: 2 }],
	});
	store.closeSegment("seg-b", "2026-05-10T04:00:00.000Z");

	store.ensureSegment({ id: "seg-c", startedAt: "2026-05-10T05:00:00.000Z" });
	store.insertRecord({
		segmentId: "seg-c",
		kind: "user",
		text: "active raw",
		happenedAt: "2026-05-10T05:00:00.000Z",
		source: source(3),
	});
	store.insertSummary({
		segmentId: "seg-c",
		depth: 1,
		text: "active summary",
		source: { sourceType: "manual", sourceRef: "sum:c1" },
		sourceItems: [{ recordId: 3 }],
	});
	return store;
}
