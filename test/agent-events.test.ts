import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentEvent } from "@earendil-works/pi-agent-core";

import {
	createAgentEventRecorder,
	storedAgentEventFromAgentEvent,
	updateAgentEventSummary,
	type AgentEventSummary,
} from "../src/agent-events.js";
import type { StoredAgentEvent } from "../src/chat-log.js";

function textDelta(delta: string): StoredAgentEvent {
	return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } };
}

function thinkingDelta(delta: string): StoredAgentEvent {
	return { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } };
}

function assistantMessage(provider: string, model: string, content: unknown[]) {
	return {
		role: "assistant",
		content,
		api: provider === "openai" ? "openai-responses" : provider === "google-vertex" ? "google-vertex" : "test",
		provider,
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function assistantUpdate(
	provider: string,
	model: string,
	content: unknown[],
	assistantMessageEvent: Record<string, unknown>,
): AgentEvent {
	const message = assistantMessage(provider, model, content);
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { ...assistantMessageEvent, partial: message },
	} as AgentEvent;
}

describe("createAgentEventRecorder", () => {
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

describe("storedAgentEventFromAgentEvent", () => {
	it("synthesizes a thinking delta when a provider only sends final thinking content", () => {
		const summary: AgentEventSummary = { thinking: "" };
		const event = assistantUpdate("openai", "gpt-5.5", [{ type: "thinking", thinking: "considered options" }], {
			type: "thinking_end",
			contentIndex: 0,
			content: "considered options",
		});

		const stored = storedAgentEventFromAgentEvent(event, summary);
		updateAgentEventSummary(summary, stored ?? event, 100);

		assert.deepEqual(stored, thinkingDelta("considered options"));
		assert.equal(summary.thinking, "considered options");
	});

	it("does not duplicate thinking_end content after streamed thinking deltas", () => {
		const summary: AgentEventSummary = { thinking: "already streamed", thinkingStart: 50, thinkingEnd: 75 };
		const event = assistantUpdate("openai", "gpt-5.5", [{ type: "thinking", thinking: "already streamed" }], {
			type: "thinking_end",
			contentIndex: 0,
			content: "already streamed",
		});

		assert.equal(storedAgentEventFromAgentEvent(event, summary), undefined);
	});

	it("routes mislabeled text deltas into thinking when the partial block is thinking", () => {
		const summary: AgentEventSummary = { thinking: "" };
		const event = assistantUpdate(
			"google-vertex",
			"gemini-3.1-pro-preview",
			[{ type: "thinking", thinking: "checking the premises" }],
			{ type: "text_delta", contentIndex: 0, delta: "checking the premises" },
		);

		const stored = storedAgentEventFromAgentEvent(event, summary);
		updateAgentEventSummary(summary, stored ?? event, 100);

		assert.deepEqual(stored, thinkingDelta("checking the premises"));
		assert.equal(summary.thinking, "checking the premises");
	});

	it("leaves Vertex text deltas with only thought signatures as text", () => {
		const summary: AgentEventSummary = { thinking: "" };
		const event = assistantUpdate(
			"google-vertex",
			"gemini-3-flash-preview",
			[{ type: "text", text: "final answer", textSignature: "opaque-signature" }],
			{ type: "text_delta", contentIndex: 0, delta: "final answer" },
		);

		assert.deepEqual(storedAgentEventFromAgentEvent(event, summary), textDelta("final answer"));
	});
});
