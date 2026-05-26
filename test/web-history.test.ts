import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChatLogRecord } from "../src/chat-log.js";
import { __webTest } from "../src/web.js";
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

describe("web history", () => {
	it("preserves interleaved assistant step order from agent events", async () => {
		const config = await configWithDataDir(await createTempDataDir());
		const records = interleavedAssistantRecords();

		const [message] = __webTest.webMessagesFromRecords(config, records, "Ghost");

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

	it("returns ordered steps from the history payload", async () => {
		const config = await configWithDataDir(await createTempDataDir());

		const body = __webTest.webHistoryPayload(config, interleavedAssistantRecords(), "Ghost", "discord-dm-channel-1", {
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

	it("preserves the FAMILIAR_SILENT marker as a text step so the frontend can render it", async () => {
		const config = await configWithDataDir(await createTempDataDir());
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

		const [message] = __webTest.webMessagesFromRecords(config, records, "Ghost");

		assert.ok(message);
		assert.equal(message.silent, true);
		assert.equal(message.text, "");
		assert.deepEqual(message.steps?.map((step) => step.kind), ["thinking", "tool", "text"]);
		const textStep = message.steps?.[2];
		assert.equal(textStep?.kind === "text" ? textStep.text : "", "[[FAMILIAR_SILENT]]");
	});

	it("keeps legit text from earlier turns plus the marker step from a later silent turn", async () => {
		const config = await configWithDataDir(await createTempDataDir());
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

		const [message] = __webTest.webMessagesFromRecords(config, records, "Ghost");

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
});
