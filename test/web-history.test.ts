import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChatLogRecord } from "../src/conversation/chat-log.js";
import { materializeInboundAttachments } from "../src/media/inbound-attachments.js";
import { webHistoryPayload, webMessagesFromRecords } from "../src/web/messages.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

function base(recordId: number, ts: string) {
	return {
		recordId,
		ts,
		service: "discord" as const,
		scope: "dm" as const,
		channelId: "channel-1",
	};
}

function interleavedAssistantRecords(): ChatLogRecord[] {
	return [
		{
			type: "agent_event",
			...base(1, "2026-05-26T00:00:00.000Z"),
			jobId: "job-1",
			messageId: "msg-1",
			event: { type: "message_start", role: "assistant" },
		},
		{
			type: "agent_event",
			...base(2, "2026-05-26T00:00:01.000Z"),
			jobId: "job-1",
			messageId: "msg-1",
			event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "think" } },
		},
		{
			type: "agent_event",
			...base(3, "2026-05-26T00:00:02.000Z"),
			jobId: "job-1",
			messageId: "msg-1",
			event: { type: "tool_execution_start", toolCallId: "tool-1", toolName: "first", args: { a: 1 } },
		},
		{
			type: "agent_event",
			...base(4, "2026-05-26T00:00:03.000Z"),
			jobId: "job-1",
			messageId: "msg-1",
			event: { type: "tool_execution_end", toolCallId: "tool-1", toolName: "first", result: "ok", isError: false },
		},
		{
			type: "agent_event",
			...base(5, "2026-05-26T00:00:04.000Z"),
			jobId: "job-1",
			messageId: "msg-1",
			event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } },
		},
		{
			type: "agent_event",
			...base(6, "2026-05-26T00:00:05.000Z"),
			jobId: "job-1",
			messageId: "msg-1",
			event: { type: "tool_execution_start", toolCallId: "tool-2", toolName: "second", args: { b: 2 } },
		},
		{
			type: "agent_event",
			...base(7, "2026-05-26T00:00:06.000Z"),
			jobId: "job-1",
			messageId: "msg-1",
			event: { type: "tool_execution_end", toolCallId: "tool-2", toolName: "second", result: "done", isError: false },
		},
		{
			type: "agent_event",
			...base(8, "2026-05-26T00:00:07.000Z"),
			jobId: "job-1",
			messageId: "msg-1",
			event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } },
		},
		{
			type: "agent_event",
			...base(9, "2026-05-26T00:00:08.000Z"),
			jobId: "job-1",
			messageId: "msg-1",
			event: { type: "message_end", role: "assistant" },
		},
		{
			type: "outbound",
			...base(10, "2026-05-26T00:00:09.000Z"),
			messageIds: ["msg-1"],
			webMessageId: "msg-1",
			text: "helloworld",
			thinking: "think",
			thinkingMs: 1000,
			jobId: "job-1",
		},
	];
}

function twoTurnRecords(): ChatLogRecord[] {
	return [
		{
			type: "inbound",
			...base(1, "2026-05-26T00:00:00.000Z"),
			messageId: "u1",
			authorId: "owner",
			authorName: "Q",
			text: "first ask",
			isBot: false,
			mentionedBot: true,
			attachments: [],
		},
		{
			type: "agent_event",
			...base(2, "2026-05-26T00:00:01.000Z"),
			jobId: "job-a",
			messageId: "msg-a",
			event: { type: "message_start", role: "assistant" },
		},
		{
			type: "agent_event",
			...base(3, "2026-05-26T00:00:02.000Z"),
			jobId: "job-a",
			messageId: "msg-a",
			event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "ponder" } },
		},
		{
			type: "agent_event",
			...base(4, "2026-05-26T00:00:03.000Z"),
			jobId: "job-a",
			messageId: "msg-a",
			event: { type: "tool_execution_start", toolCallId: "tool-a", toolName: "alpha", args: {} },
		},
		{
			type: "agent_event",
			...base(5, "2026-05-26T00:00:04.000Z"),
			jobId: "job-a",
			messageId: "msg-a",
			event: { type: "tool_execution_end", toolCallId: "tool-a", toolName: "alpha", result: "ok", isError: false },
		},
		{
			type: "agent_event",
			...base(6, "2026-05-26T00:00:05.000Z"),
			jobId: "job-a",
			messageId: "msg-a",
			event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first reply" } },
		},
		{
			type: "agent_event",
			...base(7, "2026-05-26T00:00:06.000Z"),
			jobId: "job-a",
			messageId: "msg-a",
			event: { type: "message_end", role: "assistant" },
		},
		{
			type: "outbound",
			...base(8, "2026-05-26T00:00:07.000Z"),
			messageIds: ["msg-a"],
			webMessageId: "msg-a",
			text: "first reply",
			thinking: "ponder",
			thinkingMs: 1000,
			jobId: "job-a",
		},
		{
			type: "inbound",
			...base(9, "2026-05-26T00:00:08.000Z"),
			messageId: "u2",
			authorId: "owner",
			authorName: "Q",
			text: "second ask",
			isBot: false,
			mentionedBot: true,
			attachments: [],
		},
		{
			type: "agent_event",
			...base(10, "2026-05-26T00:00:09.000Z"),
			jobId: "job-b",
			messageId: "msg-b",
			event: { type: "message_start", role: "assistant" },
		},
		{
			type: "agent_event",
			...base(11, "2026-05-26T00:00:10.000Z"),
			jobId: "job-b",
			messageId: "msg-b",
			event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "muse" } },
		},
		{
			type: "agent_event",
			...base(12, "2026-05-26T00:00:11.000Z"),
			jobId: "job-b",
			messageId: "msg-b",
			event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "second reply" } },
		},
		{
			type: "agent_event",
			...base(13, "2026-05-26T00:00:12.000Z"),
			jobId: "job-b",
			messageId: "msg-b",
			event: { type: "message_end", role: "assistant" },
		},
		{
			type: "outbound",
			...base(14, "2026-05-26T00:00:13.000Z"),
			messageIds: ["msg-b"],
			webMessageId: "msg-b",
			text: "second reply",
			thinking: "muse",
			thinkingMs: 1000,
			jobId: "job-b",
		},
	];
}

describe("web history", () => {
	it("keeps local text attachment previews out of visible user text", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const [attachment] = await materializeInboundAttachments(config, [
			{
				name: "config.txt",
				mimeType: "text/plain",
				buffer: Buffer.from('model_provider = "linkapi"\nmodel = "gpt-5.5"', "utf8"),
				source: "web",
			},
		]);
		const records: ChatLogRecord[] = [
			{
				type: "inbound",
				...base(1, "2026-05-26T00:00:00.000Z"),
				messageId: "message-1",
				authorId: "owner",
				authorName: "Q",
				text: "can u see it?",
				isBot: false,
				mentionedBot: true,
				attachments: [attachment as NonNullable<typeof attachment>],
			},
		];

		const [message] = webMessagesFromRecords(config, records, "Ghost");

		assert.ok(message);
		assert.equal(message.text, "can u see it?");
		assert.equal(message.attachments?.[0]?.name, "config.txt");
	});

	it("keeps copied-workspace attachment paths from breaking history", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const records: ChatLogRecord[] = [
			{
				type: "inbound",
				...base(1, "2026-05-26T00:00:00.000Z"),
				messageId: "message-1",
				authorId: "owner",
				authorName: "Q",
				text: "old image",
				isBot: false,
				mentionedBot: true,
				attachments: [
					{
						id: "attachment-1",
						name: "mac-image.png",
						kind: "image",
						mimeType: "image/png",
						localPath: "/Users/qearl/.familiar/data/attachments/generated/mac-image.png",
					},
				],
			},
		];

		const body = webHistoryPayload(config, records, "Ghost", "discord-dm-channel-1", { limit: 50 });

		assert.equal(body.messages[0]?.text, "old image");
		assert.equal(body.messages[0]?.attachments?.[0]?.name, "mac-image.png");
		assert.equal(body.messages[0]?.attachments?.[0]?.url, undefined);
	});

	it("preserves interleaved assistant step order from agent events", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const records = interleavedAssistantRecords();

		const [message] = webMessagesFromRecords(config, records, "Ghost");

		assert.ok(message);
		assert.deepEqual(message.steps?.map((step) => step.kind), ["thinking", "tool", "text", "tool", "text"]);
		assert.deepEqual(
			message.steps?.map((step) => (step.kind === "tool" ? step.tool.name : step.text)),
			["think", "first", "hello", "second", "world"],
		);
		assert.equal(message.text, "helloworld");
		assert.equal(message.thinking, "think");
		assert.deepEqual(message.tools?.map((tool) => tool.status), ["completed", "completed"]);
	});

	it("returns ordered steps from the history payload", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));

		const body = webHistoryPayload(config, interleavedAssistantRecords(), "Ghost", "discord-dm-channel-1", {
			limit: 50,
		});

		assert.equal(body.channelKey, "discord-dm-channel-1");
		assert.equal(body.hasMore, false);
		assert.equal(body.messages[0]?.text, "helloworld");
		assert.equal(body.messages[0]?.thinking, "think");
		assert.deepEqual(body.messages[0]?.steps?.map((step) => step.kind), [
			"thinking",
			"tool",
			"text",
			"tool",
			"text",
		]);
	});

	it("preserves the FAMILIAR_SILENT marker as a text step so the frontend can render it", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const records: ChatLogRecord[] = [
			{
				type: "agent_event",
				...base(1, "2026-05-26T00:00:00.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_start", role: "assistant" },
			},
			{
				type: "agent_event",
				...base(2, "2026-05-26T00:00:01.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "deliberating" } },
			},
			{
				type: "agent_event",
				...base(3, "2026-05-26T00:00:02.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "tool_execution_start", toolCallId: "tool-1", toolName: "search", args: { q: "x" } },
			},
			{
				type: "agent_event",
				...base(4, "2026-05-26T00:00:03.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "tool_execution_end", toolCallId: "tool-1", toolName: "search", result: "ok", isError: false },
			},
			{
				type: "agent_event",
				...base(5, "2026-05-26T00:00:04.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "[[FAMILIAR_SILENT]]" } },
			},
			{
				type: "agent_event",
				...base(6, "2026-05-26T00:00:05.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_end", role: "assistant" },
			},
			{
				type: "outbound",
				...base(7, "2026-05-26T00:00:06.000Z"),
				messageIds: ["msg-1"],
				webMessageId: "msg-1",
				text: "",
				thinking: "deliberating",
				thinkingMs: 1000,
				jobId: "job-1",
				silent: true,
			},
		];

		const [message] = webMessagesFromRecords(config, records, "Ghost");

		assert.ok(message);
		assert.equal(message.silent, true);
		assert.equal(message.text, "");
		assert.deepEqual(message.steps?.map((step) => step.kind), ["thinking", "tool", "text"]);
		const textStep = message.steps?.[2];
		assert.equal(textStep?.kind === "text" ? textStep.text : "", "[[FAMILIAR_SILENT]]");
	});

	it("renders a model error as a raw error step instead of plain dialogue text", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const records: ChatLogRecord[] = [
			{
				type: "agent_event",
				...base(1, "2026-05-26T00:00:00.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_start", role: "assistant" },
			},
			{
				type: "agent_event",
				...base(2, "2026-05-26T00:00:01.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_end", role: "assistant", errorMessage: "503 Service Unavailable" },
			},
			{
				type: "outbound",
				...base(3, "2026-05-26T00:00:02.000Z"),
				messageIds: ["msg-1"],
				webMessageId: "msg-1",
				text: "Model error: 503 Service Unavailable",
				jobId: "job-1",
			},
		];

		const [message] = webMessagesFromRecords(config, records, "Ghost");

		assert.ok(message);
		assert.deepEqual(
			message.steps?.map((step) => step.kind),
			["error"],
		);
		const errorStep = message.steps?.[0];
		assert.equal(errorStep?.kind === "error" ? errorStep.text : "", "503 Service Unavailable");
		assert.ok(!message.steps?.some((step) => step.kind === "text"));
	});

	it("renders streamed assistant text that ends with an error without an outbound anchor", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const records: ChatLogRecord[] = [
			{
				type: "agent_event",
				...base(1, "2026-05-26T00:00:00.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_start", role: "assistant" },
			},
			{
				type: "agent_event",
				...base(2, "2026-05-26T00:00:01.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial reply" } },
			},
			{
				type: "agent_event",
				...base(3, "2026-05-26T00:00:02.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_end", role: "assistant", errorMessage: "503 Service Unavailable" },
			},
		];

		const [message] = webMessagesFromRecords(config, records, "Ghost");
		const page = webHistoryPayload(config, records, "Ghost", "discord-dm-channel-1", { limit: 1 });

		assert.ok(message);
		assert.equal(message.id, "msg-1");
		assert.equal(message.text, "partial reply");
		assert.deepEqual(message.steps?.map((step) => step.kind), ["text", "error"]);
		assert.deepEqual(page.messages.map((entry) => entry.id), ["msg-1"]);
		assert.deepEqual(page.messages[0]?.steps?.map((step) => step.kind), ["text", "error"]);
	});

	it("keeps legit text from earlier turns plus the marker step from a later silent turn", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const records: ChatLogRecord[] = [
			// turn A: thinking + tool 1
			{
				type: "agent_event",
				...base(1, "2026-05-26T00:00:00.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_start", role: "assistant" },
			},
			{
				type: "agent_event",
				...base(2, "2026-05-26T00:00:01.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "plan" } },
			},
			{
				type: "agent_event",
				...base(3, "2026-05-26T00:00:02.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "tool_execution_start", toolCallId: "tool-1", toolName: "first", args: {} },
			},
			{
				type: "agent_event",
				...base(4, "2026-05-26T00:00:03.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "tool_execution_end", toolCallId: "tool-1", toolName: "first", result: "ok", isError: false },
			},
			{
				type: "agent_event",
				...base(5, "2026-05-26T00:00:04.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_end", role: "assistant" },
			},
			// turn B: real text + tool 2
			{
				type: "agent_event",
				...base(6, "2026-05-26T00:00:05.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_start", role: "assistant" },
			},
			{
				type: "agent_event",
				...base(7, "2026-05-26T00:00:06.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "real text" } },
			},
			{
				type: "agent_event",
				...base(8, "2026-05-26T00:00:07.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "tool_execution_start", toolCallId: "tool-2", toolName: "second", args: {} },
			},
			{
				type: "agent_event",
				...base(9, "2026-05-26T00:00:08.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "tool_execution_end", toolCallId: "tool-2", toolName: "second", result: "ok", isError: false },
			},
			{
				type: "agent_event",
				...base(10, "2026-05-26T00:00:09.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_end", role: "assistant" },
			},
			// turn C: silent marker only
			{
				type: "agent_event",
				...base(11, "2026-05-26T00:00:10.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_start", role: "assistant" },
			},
			{
				type: "agent_event",
				...base(12, "2026-05-26T00:00:11.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "[[FAMILIAR_SILENT]]" } },
			},
			{
				type: "agent_event",
				...base(13, "2026-05-26T00:00:12.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_end", role: "assistant" },
			},
			{
				type: "outbound",
				...base(14, "2026-05-26T00:00:13.000Z"),
				messageIds: ["msg-1"],
				webMessageId: "msg-1",
				text: "",
				thinking: "plan",
				thinkingMs: 1000,
				jobId: "job-1",
				silent: true,
			},
		];

		const [message] = webMessagesFromRecords(config, records, "Ghost");

		assert.ok(message);
		assert.equal(message.silent, true);
		assert.deepEqual(message.steps?.map((step) => step.kind), [
			"thinking",
			"tool",
			"text",
			"tool",
			"text",
		]);
		const realText = message.steps?.[2];
		assert.equal(realText?.kind === "text" ? realText.text : "", "real text");
		const markerText = message.steps?.[4];
		assert.equal(markerText?.kind === "text" ? markerText.text : "", "[[FAMILIAR_SILENT]]");
	});

	it("replays agent events for the page when paging backward past a cursor", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const records = twoTurnRecords();

		const first = webHistoryPayload(config, records, "Ghost", "discord-dm-channel-1", { limit: 2 });
		assert.equal(first.hasMore, true);
		assert.deepEqual(first.messages.map((message) => message.id), ["u2", "msg-b"]);
		const newest = first.messages[1];
		assert.equal(newest?.thinking, "muse");
		assert.deepEqual(newest?.steps?.map((step) => step.kind), ["thinking", "text"]);

		const second = webHistoryPayload(config, records, "Ghost", "discord-dm-channel-1", {
			limit: 2,
			before: "msg-b",
		});
		assert.equal(second.hasMore, true);
		assert.deepEqual(second.messages.map((message) => message.id), ["msg-a", "u2"]);
		const older = second.messages[0];
		assert.equal(older?.text, "first reply");
		assert.equal(older?.thinking, "ponder");
		assert.deepEqual(older?.steps?.map((step) => step.kind), ["thinking", "tool", "text"]);
		assert.deepEqual(
			older?.steps?.map((step) => (step.kind === "tool" ? step.tool.name : step.text)),
			["ponder", "alpha", "first reply"],
		);
	});

	it("hides superseded assistant turns after retry", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const records: ChatLogRecord[] = [
			...twoTurnRecords(),
			{
				type: "assistant_retry",
				...base(15, "2026-05-26T00:00:14.000Z"),
				oldMessageId: "msg-b",
				newMessageId: "msg-c",
				jobId: "job-c",
				triggerRecordId: 9,
			},
			{
				type: "agent_event",
				...base(16, "2026-05-26T00:00:15.000Z"),
				jobId: "job-c",
				messageId: "msg-c",
				event: { type: "message_start", role: "assistant" },
			},
			{
				type: "agent_event",
				...base(17, "2026-05-26T00:00:16.000Z"),
				jobId: "job-c",
				messageId: "msg-c",
				event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "retry reply" } },
			},
			{
				type: "agent_event",
				...base(18, "2026-05-26T00:00:17.000Z"),
				jobId: "job-c",
				messageId: "msg-c",
				event: { type: "message_end", role: "assistant" },
			},
			{
				type: "outbound",
				...base(19, "2026-05-26T00:00:18.000Z"),
				messageIds: ["msg-c"],
				webMessageId: "msg-c",
				text: "retry reply",
				jobId: "job-c",
			},
		];

		const messages = webMessagesFromRecords(config, records, "Ghost");

		assert.deepEqual(messages.map((message) => message.id), ["u1", "msg-a", "u2", "msg-c"]);
		assert.equal(messages.at(-1)?.text, "retry reply");
	});

	it("hides deleted assistant turns and their agent events", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const records: ChatLogRecord[] = [
			...twoTurnRecords(),
			{
				type: "message_delete",
				...base(15, "2026-05-26T00:00:14.000Z"),
				messageId: "msg-b",
			},
		];

		const messages = webMessagesFromRecords(config, records, "Ghost");
		const page = webHistoryPayload(config, records, "Ghost", "discord-dm-channel-1", { limit: 10 });

		assert.deepEqual(messages.map((message) => message.id), ["u1", "msg-a", "u2"]);
		assert.deepEqual(page.messages.map((message) => message.id), ["u1", "msg-a", "u2"]);
		assert.equal(messages.some((message) => message.text === "second reply"), false);
	});

	it("applies edited assistant text in full and paginated history", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const records: ChatLogRecord[] = [
			...twoTurnRecords(),
			{
				type: "message_edit",
				...base(15, "2026-05-26T00:00:14.000Z"),
				messageId: "msg-b",
				text: "cleaned up reply",
			},
		];

		const messages = webMessagesFromRecords(config, records, "Ghost");
		const page = webHistoryPayload(config, records, "Ghost", "discord-dm-channel-1", { limit: 2 });

		assert.equal(messages.at(-1)?.text, "cleaned up reply");
		assert.equal(page.messages.at(-1)?.text, "cleaned up reply");
		assert.deepEqual(page.messages.at(-1)?.steps?.filter((step) => step.kind === "text").map((step) => step.text), [
			"cleaned up reply",
		]);
	});

	it("collapses assistant text steps when applying an edit", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const records: ChatLogRecord[] = [
			...interleavedAssistantRecords(),
			{
				type: "message_edit",
				...base(11, "2026-05-26T00:00:10.000Z"),
				messageId: "msg-1",
				text: "cleaned up",
			},
		];

		const [message] = webMessagesFromRecords(config, records, "Ghost");
		const page = webHistoryPayload(config, records, "Ghost", "discord-dm-channel-1", { limit: 1 });
		const pageMessage = page.messages[0];

		assert.ok(message);
		assert.deepEqual(message.steps?.map((step) => step.kind), ["thinking", "tool", "text", "tool"]);
		assert.deepEqual(
			message.steps?.map((step) => (step.kind === "tool" ? step.tool.name : step.text)),
			["think", "first", "cleaned up", "second"],
		);
		assert.equal(message.text, "cleaned up");
		assert.equal(pageMessage?.text, "cleaned up");
		assert.deepEqual(pageMessage?.steps?.map((step) => step.kind), ["thinking", "tool", "text", "tool"]);
	});

	it("clears model error steps when applying an edit", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const records: ChatLogRecord[] = [
			...interleavedAssistantRecords(),
			{
				type: "agent_event",
				...base(11, "2026-05-26T00:00:10.000Z"),
				jobId: "job-1",
				messageId: "msg-1",
				event: { type: "message_end", role: "assistant", errorMessage: "503 Service Unavailable" },
			},
			{
				type: "message_edit",
				...base(12, "2026-05-26T00:00:11.000Z"),
				messageId: "msg-1",
				text: "cleaned up",
			},
		];

		const [message] = webMessagesFromRecords(config, records, "Ghost");

		assert.ok(message);
		assert.deepEqual(message.steps?.map((step) => step.kind), ["thinking", "tool", "text", "tool"]);
		assert.equal(message.steps?.some((step) => step.kind === "error"), false);
	});
});
