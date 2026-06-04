import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChatLogRecord } from "../src/conversation/chat-log.js";
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

	it("normalizes assistant tool_call into record with tool_call part", () => {
		const batch = normalizeChatRecords(
			[
				{
					...base,
					type: "agent_event",
					recordId: 1,
					jobId: "job-1",
					messageId: "event-1",
					event: {
						type: "message_update",
						assistantMessageEvent: {
							type: "toolcall_end",
							contentIndex: 0,
							toolCall: { id: "call-1", name: "read", arguments: { path: "PLAN.md" } },
						},
					},
				},
				{
					...base,
					type: "outbound",
					recordId: 2,
					messageIds: ["m2"],
					text: "I will inspect the plan.",
					jobId: "job-1",
				},
			],
			{ segmentId: "seg-a" },
		);

		assert.equal(batch.records.length, 1);
		assert.equal(batch.records[0]?.kind, "assistant");
		assert.deepEqual(batch.records[0]?.parts, [
			{ kind: "tool_call", toolCallId: "call-1", toolName: "read", arguments: { path: "PLAN.md" } },
			{ kind: "text", text: "I will inspect the plan." },
		]);
		assert.match(batch.records[0]?.text ?? "", /\[tool_call: read/);
	});

	it("does not duplicate outbound final text already captured in text deltas", () => {
		const batch = normalizeChatRecords(
			[
				{
					...base,
					type: "agent_event",
					recordId: 1,
					jobId: "job-1",
					messageId: "event-1",
					event: {
						type: "message_update",
						assistantMessageEvent: {
							type: "text_delta",
							delta: "fish pie, you mean? ",
						},
					},
				},
				{
					...base,
					type: "agent_event",
					recordId: 2,
					jobId: "job-1",
					messageId: "event-2",
					event: {
						type: "message_update",
						assistantMessageEvent: {
							type: "text_delta",
							delta: "looks cursed.",
						},
					},
				},
				{
					...base,
					type: "outbound",
					recordId: 3,
					messageIds: ["m2"],
					text: "fish pie, you mean? looks cursed.",
					jobId: "job-1",
				},
			],
			{ segmentId: "seg-a" },
		);

		assert.equal(batch.records.length, 1);
		assert.equal(batch.records[0]?.text, "fish pie, you mean? looks cursed.");
		assert.deepEqual(batch.records[0]?.parts, [{ kind: "text", text: "fish pie, you mean? looks cursed." }]);
	});

	it("normalizes tool_result chat record into tool_result part", () => {
		const batch = normalizeChatRecords(
			[
				{
					...base,
					type: "agent_event",
					recordId: 1,
					jobId: "job-1",
					messageId: "event-1",
					event: {
						type: "tool_execution_end",
						toolCallId: "call-1",
						toolName: "read",
						result: {
							content: [{ type: "text", text: "visible roadmap" }],
							details: { text: "details-only roadmap", path: "PLAN.md" },
						},
						isError: false,
					},
				},
			],
			{ segmentId: "seg-a" },
		);

		assert.equal(batch.records.length, 1);
		assert.equal(batch.records[0]?.kind, "tool");
		assert.deepEqual(batch.records[0]?.parts, [
			{ kind: "tool_result", toolCallId: "call-1", toolName: "read", output: "visible roadmap" },
		]);
		assert.match(batch.records[0]?.text ?? "", /visible roadmap/);
		assert.doesNotMatch(batch.records[0]?.text ?? "", /details-only roadmap/);
	});

	it("preserves legacy unshaped tool_result values", () => {
		const batch = normalizeChatRecords(
			[
				{
					...base,
					type: "agent_event",
					recordId: 1,
					jobId: "job-1",
					messageId: "event-1",
					event: {
						type: "tool_execution_end",
						toolCallId: "call-1",
						toolName: "read",
						result: { ok: true, text: "legacy roadmap" },
						isError: false,
					},
				},
			],
			{ segmentId: "seg-a" },
		);

		assert.deepEqual(batch.records[0]?.parts, [
			{ kind: "tool_result", toolCallId: "call-1", toolName: "read", output: { ok: true, text: "legacy roadmap" } },
		]);
	});
});
