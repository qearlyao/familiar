import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAgentEventRecorder, modelErrorFromAgentEvent } from "../src/runtime/agent-events.js";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { StoredAgentEvent } from "../src/conversation/chat-log.js";

function textDelta(delta: string): StoredAgentEvent {
	return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } };
}

function thinkingDelta(delta: string): StoredAgentEvent {
	return { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } };
}

describe("createAgentEventRecorder", () => {
	it("matches the WebUI model-error event criterion", () => {
		const event = {
			type: "message_end",
			message: { role: "assistant", errorMessage: "503 Service Unavailable" },
		} as AgentEvent;
		assert.equal(modelErrorFromAgentEvent(event), "503 Service Unavailable");
		assert.equal(modelErrorFromAgentEvent({ type: "message_end", message: { role: "user" } } as AgentEvent), undefined);
	});

	it("coalesces adjacent deltas of the same kind", async () => {
		const written: StoredAgentEvent[] = [];
		const recorder = createAgentEventRecorder(async (event) => {
			written.push(event);
		});

		await recorder.record(textDelta("hel"));
		await recorder.record(textDelta("lo"));
		await recorder.record(thinkingDelta("hmm"));
		await recorder.record(thinkingDelta("..."));
		await recorder.flush();

		assert.deepEqual(written, [textDelta("hello"), thinkingDelta("hmm...")]);
	});

	it("keeps separate delta groups when the kind changes", async () => {
		const written: StoredAgentEvent[] = [];
		const recorder = createAgentEventRecorder(async (event) => {
			written.push(event);
		});

		await recorder.record(textDelta("a"));
		await recorder.record(textDelta("b"));
		await recorder.record(thinkingDelta("c"));
		await recorder.record(textDelta("d"));
		await recorder.flush();

		assert.deepEqual(written, [textDelta("ab"), thinkingDelta("c"), textDelta("d")]);
	});

	it("treats empty flushes as no-ops", async () => {
		const written: StoredAgentEvent[] = [];
		const recorder = createAgentEventRecorder(async (event) => {
			written.push(event);
		});

		await recorder.flush();
		await recorder.record(textDelta(""));
		await recorder.flush();
		await recorder.record(textDelta("next"));
		await recorder.flush();

		assert.deepEqual(written, [textDelta("next")]);
	});

	it("flushes pending deltas before non-delta events", async () => {
		const written: StoredAgentEvent[] = [];
		const recorder = createAgentEventRecorder(async (event) => {
			written.push(event);
		});
		const toolStart: StoredAgentEvent = {
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "read",
			args: { path: "README.md" },
		};

		await recorder.record(textDelta("before"));
		await recorder.record(toolStart);
		await recorder.flush();

		assert.deepEqual(written, [textDelta("before"), toolStart]);
	});
});
