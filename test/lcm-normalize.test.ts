import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChatLogRecord } from "../src/chat-log.js";
import { normalizeChatRecords } from "../src/memory/lcm/normalize.js";

const base = {
	ts: "2026-05-10T01:00:00.000Z",
	service: "web",
	scope: "web",
	channelId: "room",
} as const;

describe("normalizeChatRecords", () => {
	it("keeps conversational records and reset boundaries while skipping noisy lifecycle records", () => {
		const records: ChatLogRecord[] = [
			{
				...base,
				type: "inbound",
				recordId: 1,
				messageId: "m1",
				authorId: "u1",
				authorName: "Q",
				text: "Look at this sketch",
				isBot: false,
				mentionedBot: false,
				attachments: [
					{
						id: "a1",
						name: "sketch.png",
						kind: "image",
						derived: { image: { mimeType: "image/png", size: 12, note: "rough interface sketch" } },
					},
				],
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
				text: "The sketch suggests a compact toolbar.",
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
				type: "control",
				recordId: 6,
				command: "new",
				authorId: "u1",
				text: "/new",
			},
			{
				...base,
				type: "runtime",
				recordId: 7,
				event: "reset",
				detail: "new conversation requested",
			},
			{
				...base,
				type: "outbound",
				recordId: 8,
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

		assert.deepEqual(
			batch.records.map((record) => ({ kind: record.kind, text: record.text, sourceRecordId: record.source.sourceRecordId })),
			[
				{ kind: "user", text: "Look at this sketch\nrough interface sketch", sourceRecordId: 1 },
				{ kind: "assistant", text: "The sketch suggests a compact toolbar.", sourceRecordId: 4 },
				{ kind: "boundary", text: "/new", sourceRecordId: 6 },
				{ kind: "boundary", text: "new conversation requested", sourceRecordId: 7 },
			],
		);
		assert.equal(batch.records[0]?.attachments?.[0]?.note, "rough interface sketch");
		assert.equal(batch.records[0]?.source.sourceRef, "data/chat/web-web-room/2026-05-10.jsonl#1");
		assert.deepEqual(batch.segments, [
			{
				id: "seg-a",
				sessionId: "session-a",
				channelKey: "web-web-room",
				startedAt: "2026-05-10T01:00:00.000Z",
			},
		]);
	});
});
