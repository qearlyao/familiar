import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import Database from "better-sqlite3";

import { LcmStore } from "../src/memory/lcm/store.js";
import type { LcmSourceProvenance, LcmSummarySnapshot } from "../src/memory/lcm/types.js";

async function tempDbPath(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "familiar-lcm-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
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

async function openStore(t: { after(fn: () => Promise<void>): void }): Promise<LcmStore> {
	return new LcmStore({ path: await tempDbPath(t) });
}

describe("LcmStore", () => {
	it("creates the normalized source DB and round-trips records with provenance", async (t) => {
		const store = await openStore(t);
		try {
			assert.equal(store.schemaVersion(), 10);
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
			assert.equal(store.listSegments()[0]?.metadata?.reason, "initial");
		} finally {
			store.close();
		}
	});

	it("round-trips parts_json through insert and getRecord", async (t) => {
		const store = await openStore(t);
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

	it("stores summary placeholders and provenance edges", async (t) => {
		const store = await openStore(t);
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

	it("rolls back implicit segment creation when record insert fails", async (t) => {
		const store = await openStore(t);
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

	it("deletes summary source rows when retained summaries are pruned", async (t) => {
		const store = await storeWithClosedSegments(t);
		try {
			assert.ok(store.getSummarySources(1).length > 0);

			store.applyNewSessionRetention({ newSessionRetainDepth: 2, activeSegmentId: "seg-c" });

			assert.equal(store.getSummarySources(1).length, 0);
		} finally {
			store.close();
		}
	});

	it("insertSummary with parents populates lcm_summary_parents and getSummaryParents returns them", async (t) => {
		const store = await openStore(t);
		try {
			const first = store.insertSummary({
				segmentId: "seg-parents",
				depth: 1,
				status: "ready",
				text: "first child summary",
				source: { sourceType: "manual", sourceRef: "sum:first" },
			});
			const second = store.insertSummary({
				segmentId: "seg-parents",
				depth: 1,
				status: "ready",
				text: "second child summary",
				source: { sourceType: "manual", sourceRef: "sum:second" },
			});
			const parent = store.insertSummary({
				segmentId: "seg-parents",
				depth: 2,
				status: "ready",
				text: "condensed parent",
				source: { sourceType: "manual", sourceRef: "sum:parent" },
				parents: [first, second],
			});

			assert.deepEqual(store.getSummaryParents(parent), [first, second]);
			assert.deepEqual(store.getSummary(parent)?.parents, [first, second]);
			assert.deepEqual(store.getSummaryChildren(first), [parent]);
			assert.throws(
				() =>
					store.insertSummary({
						segmentId: "seg-parents",
						depth: 2,
						status: "ready",
						text: "bad parent",
						source: { sourceType: "manual", sourceRef: "sum:bad" },
						parents: [9999],
					}),
				/parent does not exist/,
			);
		} finally {
			store.close();
		}
	});

	it("insertSummary dedupes concurrent summary_key inserts in one transaction path", async (t) => {
		const store = await openStore(t);
		try {
			const input = {
				segmentId: "seg-concurrent",
				depth: 1,
				status: "ready" as const,
				text: "concurrent summary",
				source: { sourceType: "manual" as const, sourceRef: "sum:concurrent" },
			};
			const [first, second] = await Promise.all([store.insertSummary(input), store.insertSummary(input)]);

			assert.equal(first, second);
			assert.equal(store.listSummaries("seg-concurrent").length, 1);
		} finally {
			store.close();
		}
	});

	it("deleting a parent summary cascades through lcm_summary_parents", async (t) => {
		const store = await openStore(t);
		try {
			const child = store.insertSummary({
				segmentId: "seg-cascade-parents",
				depth: 1,
				status: "ready",
				text: "child summary",
				source: { sourceType: "manual", sourceRef: "sum:child" },
			});
			const parent = store.insertSummary({
				segmentId: "seg-cascade-parents",
				depth: 2,
				status: "ready",
				text: "parent summary",
				source: { sourceType: "manual", sourceRef: "sum:parent" },
				parents: [child],
			});
			assert.deepEqual(store.getSummaryParents(parent), [child]);

			store.db.prepare("DELETE FROM lcm_summaries WHERE id = ?").run(child);

			assert.deepEqual(store.getSummaryParents(parent), []);
			assert.deepEqual(store.getSummaryChildren(child), []);
		} finally {
			store.close();
		}
	});

	it("enables foreign key enforcement on opened store connections", async (t) => {
		const path = await tempDbPath(t);
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

	it("keeps all context for newSessionRetainDepth -1", async (t) => {
		const store = await storeWithClosedSegments(t);
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

	it("drops raw records but keeps summaries for newSessionRetainDepth 0", async (t) => {
		const store = await storeWithClosedSegments(t);
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

	it("snapshot_json populated on retainDepth 0", async (t) => {
		const store = await openStore(t);
		try {
			const first = store.insertRecord({
				segmentId: "seg-snapshot",
				kind: "user",
				text: "please inspect the plan",
				happenedAt: "2026-05-10T01:00:00.000Z",
				source: source(1),
				metadata: { role: "user" },
			});
			const longText = `${"a".repeat(4096)}tail`;
			const second = store.insertRecord({
				segmentId: "seg-snapshot",
				kind: "assistant",
				text: longText,
				parts: [
					{ kind: "thinking", text: "Need the current plan." },
					{ kind: "tool_call", toolCallId: "call-1", toolName: "read", arguments: { path: "PLAN.md" } },
					{ kind: "tool_result", toolCallId: "call-1", toolName: "read", output: { ok: true } },
				],
				happenedAt: "2026-05-10T01:01:00.000Z",
				source: source(2),
				attachments: [{ id: "att-1", name: "plan.txt", kind: "text", note: "plan excerpt" }],
			});
			const summaryId = store.insertSummary({
				segmentId: "seg-snapshot",
				depth: 1,
				status: "ready",
				text: "summary over raw records",
				coversFromRecordId: first,
				coversToRecordId: second,
				source: { sourceType: "manual", sourceRef: "sum:snapshot" },
			});
			store.closeSegment("seg-snapshot", "2026-05-10T02:00:00.000Z");

			store.applyNewSessionRetention({ newSessionRetainDepth: 0 });

			assert.deepEqual(store.listRecords("seg-snapshot"), []);
			const summary = store.getSummary(summaryId);
			assert.ok(summary);
			assert.equal(summary.coversFromRecordId, null);
			assert.equal(summary.coversToRecordId, null);
			const snapshot = summary.snapshot as LcmSummarySnapshot | null;
			assert.deepEqual(
				snapshot?.map((item) => ({
					id: item.id,
					kind: item.kind,
					happened_at: item.happened_at,
					role: item.role,
					parts: item.parts,
					attachments: item.attachments,
				})),
				[
					{
						id: first,
						kind: "user",
						happened_at: "2026-05-10T01:00:00.000Z",
						role: "user",
						parts: null,
						attachments: null,
					},
					{
						id: second,
						kind: "assistant",
						happened_at: "2026-05-10T01:01:00.000Z",
						role: "assistant",
						parts: [
							{ kind: "thinking", text: "Need the current plan." },
							{ kind: "tool_call", toolCallId: "call-1", toolName: "read", arguments: { path: "PLAN.md" } },
							{ kind: "tool_result", toolCallId: "call-1", toolName: "read", output: { ok: true } },
						],
						attachments: [{ id: "att-1", name: "plan.txt", kind: "text", note: "plan excerpt" }],
					},
				],
			);
			assert.equal(snapshot?.[0]?.text, "please inspect the plan");
			assert.equal(snapshot?.[1]?.text.length, 4096);
			assert.ok(snapshot?.[1]?.text.endsWith("…[truncated]"));
		} finally {
			store.close();
		}
	});

	it("only surviving summaries snapshotted on retainDepth 2", async (t) => {
		const store = await openStore(t);
		try {
			const first = store.insertRecord({
				segmentId: "seg-depth",
				kind: "user",
				text: "depth retention source",
				happenedAt: "2026-05-10T01:00:00.000Z",
				source: source(1),
			});
			const second = store.insertRecord({
				segmentId: "seg-depth",
				kind: "assistant",
				text: "depth retention reply",
				happenedAt: "2026-05-10T01:01:00.000Z",
				source: source(2),
			});
			store.insertSummary({
				segmentId: "seg-depth",
				depth: 1,
				status: "ready",
				text: "depth one summary",
				coversFromRecordId: first,
				coversToRecordId: second,
				source: { sourceType: "manual", sourceRef: "sum:d1" },
			});
			const retainedId = store.insertSummary({
				segmentId: "seg-depth",
				depth: 2,
				status: "ready",
				text: "depth two summary",
				coversFromRecordId: first,
				coversToRecordId: second,
				source: { sourceType: "manual", sourceRef: "sum:d2" },
			});
			store.closeSegment("seg-depth", "2026-05-10T02:00:00.000Z");

			store.applyNewSessionRetention({ newSessionRetainDepth: 2 });

			const summaries = store.listSummaries("seg-depth");
			assert.deepEqual(
				summaries.map((summary) => ({ id: summary.id, depth: summary.depth, text: summary.text })),
				[{ id: retainedId, depth: 2, text: "depth two summary" }],
			);
			const snapshot = summaries[0]?.snapshot as LcmSummarySnapshot | null | undefined;
			assert.deepEqual(
				snapshot?.map((item) => ({ id: item.id, kind: item.kind, text: item.text })),
				[
					{ id: first, kind: "user", text: "depth retention source" },
					{ id: second, kind: "assistant", text: "depth retention reply" },
				],
			);
		} finally {
			store.close();
		}
	});

	it("no snapshot written on retainDepth -1", async (t) => {
		const store = await openStore(t);
		try {
			const first = store.insertRecord({
				segmentId: "seg-keep",
				kind: "user",
				text: "kept raw",
				happenedAt: "2026-05-10T01:00:00.000Z",
				source: source(1),
			});
			const summaryId = store.insertSummary({
				segmentId: "seg-keep",
				depth: 1,
				status: "ready",
				text: "kept summary",
				coversFromRecordId: first,
				coversToRecordId: first,
				source: { sourceType: "manual", sourceRef: "sum:keep" },
			});
			store.closeSegment("seg-keep", "2026-05-10T02:00:00.000Z");

			store.applyNewSessionRetention({ newSessionRetainDepth: -1 });

			assert.equal(store.listRecords("seg-keep").length, 1);
			assert.equal(store.listSummaries("seg-keep").length, 1);
			assert.equal(store.getSummary(summaryId)?.snapshot, null);
			assert.equal(
				(
					store.db.prepare("SELECT snapshot_json FROM lcm_summaries WHERE id = ?").get(summaryId) as {
						snapshot_json: string | null;
					}
				).snapshot_json,
				null,
			);
		} finally {
			store.close();
		}
	});

	it("keeps only retained-depth or pinned summaries for positive newSessionRetainDepth", async (t) => {
		const store = await storeWithClosedSegments(t);
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

	it("replaceContextItems atomically replaces rows with sequential ordinals", async (t) => {
		const store = await openStore(t);
		try {
			const firstRecord = store.insertRecord({
				segmentId: "seg-context",
				kind: "user",
				text: "first context raw",
				happenedAt: "2026-05-10T01:00:00.000Z",
				source: source(1),
			});
			const secondRecord = store.insertRecord({
				segmentId: "seg-context",
				kind: "assistant",
				text: "second context raw",
				happenedAt: "2026-05-10T01:01:00.000Z",
				source: source(2),
			});
			const firstSummaryId = store.insertSummary({
				segmentId: "seg-context",
				depth: 1,
				status: "ready",
				text: "first context summary",
				coversFromRecordId: firstRecord,
				coversToRecordId: firstRecord,
				source: { sourceType: "manual", sourceRef: "sum:context:first" },
			});
			const secondSummaryId = store.insertSummary({
				segmentId: "seg-context",
				depth: 1,
				status: "ready",
				text: "second context summary",
				coversFromRecordId: secondRecord,
				coversToRecordId: secondRecord,
				source: { sourceType: "manual", sourceRef: "sum:context:second" },
			});
			store.replaceContextItems("room-context", [
				{ summaryId: firstSummaryId, fingerprint: "summary:first", happenedAt: null },
				{ summaryId: secondSummaryId, fingerprint: "summary:second", happenedAt: null },
			]);
			store.replaceContextItems("room-context", [
				{ summaryId: secondSummaryId, fingerprint: "summary:second", happenedAt: null },
			]);

			assert.deepEqual(
				store.listContextItems("room-context").map((item) => ({
					ordinal: item.ordinal,
					summaryId: item.summaryId,
					fingerprint: item.fingerprint,
				})),
				[{ ordinal: 0, summaryId: secondSummaryId, fingerprint: "summary:second" }],
			);
		} finally {
			store.close();
		}
	});

	it("migrates legacy context items by preserving summaries and dropping raw rows", async (t) => {
		const path = await tempDbPath(t);
		let store = new LcmStore({ path });
		let summaryId: number;
		try {
			const recordId = store.insertRecord({
				segmentId: "seg-legacy-context",
				kind: "user",
				text: "legacy raw context",
				happenedAt: "2026-05-10T01:00:00.000Z",
				source: source(1),
			});
			summaryId = store.insertSummary({
				segmentId: "seg-legacy-context",
				depth: 1,
				status: "ready",
				text: "legacy context summary",
				coversFromRecordId: recordId,
				coversToRecordId: recordId,
				source: { sourceType: "manual", sourceRef: "sum:legacy-context" },
			});
			store.db.exec(`
				DROP TABLE lcm_context_items;
				CREATE TABLE lcm_context_items (
					session_key TEXT NOT NULL,
					ordinal INTEGER NOT NULL,
					item_type TEXT NOT NULL CHECK(item_type IN ('raw', 'summary')),
					record_id INTEGER REFERENCES lcm_records(id) ON DELETE CASCADE,
					summary_id INTEGER REFERENCES lcm_summaries(id) ON DELETE CASCADE,
					fingerprint TEXT NOT NULL,
					happened_at TEXT,
					updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
					PRIMARY KEY(session_key, ordinal)
				);
			`);
			const insert = store.db.prepare(
				`INSERT INTO lcm_context_items (
					session_key, ordinal, item_type, record_id, summary_id, fingerprint, happened_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			);
			insert.run("room-legacy", 0, "raw", recordId, null, "legacy:raw", null);
			insert.run("room-legacy", 1, "summary", null, summaryId, "legacy:summary", null);
		} finally {
			store.close();
		}

		store = new LcmStore({ path });
		try {
			assert.equal(store.schemaVersion(), 10);
			assert.deepEqual(
				store.listContextItems("room-legacy").map((item) => ({
					ordinal: item.ordinal,
					summaryId: item.summaryId,
					fingerprint: item.fingerprint,
				})),
				[{ ordinal: 1, summaryId, fingerprint: "legacy:summary" }],
			);
			const columns = store.db.prepare("PRAGMA table_info(lcm_context_items)").all() as Array<{
				name: string;
				notnull: number;
			}>;
			assert.deepEqual(
				columns.map((column) => column.name),
				["session_key", "ordinal", "summary_id", "fingerprint", "happened_at", "updated_at"],
			);
			assert.equal(columns.find((column) => column.name === "summary_id")?.notnull, 1);
		} finally {
			store.close();
		}
	});

});

async function storeWithClosedSegments(t: { after(fn: () => Promise<void>): void }): Promise<LcmStore> {
	const store = await openStore(t);
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
		sourceItems: [{ sourceRef: "lcm_summary:1" }],
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
