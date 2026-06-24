import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai/compat";

import { normalizeToolNameStream } from "../src/agent/tool-name-compat.js";

describe("tool name compatibility", () => {
	it("canonicalizes assistant tool names by unique case-insensitive registered tool match", async () => {
		const source = createAssistantMessageEventStream();
		const wrapped = normalizeToolNameStream(source, [{ name: "bash" }, { name: "read" }]);

		source.push({
			type: "done",
			reason: "toolUse",
			message: assistantWithToolCalls(["Bash", "Read", "missing"]),
		});

		const result = await wrapped.result();
		assert.deepEqual(toolCallNames(result), ["bash", "read", "missing"]);
	});

	it("normalizes streamed tool call events and partial messages", async () => {
		const source = createAssistantMessageEventStream();
		const wrapped = normalizeToolNameStream(source, [{ name: "bash" }]);
		const message = assistantWithToolCalls(["Bash"]);
		const events = collectEvents(wrapped);

		source.push({
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: message.content[0]!,
			partial: message,
		});
		source.push({ type: "done", reason: "toolUse", message });

		const [toolEnd] = await events;
		assert.equal(toolEnd?.type, "toolcall_end");
		if (toolEnd?.type === "toolcall_end") {
			assert.equal(toolEnd.toolCall.name, "bash");
			assert.deepEqual(toolCallNames(toolEnd.partial), ["bash"]);
		}
	});

	it("leaves exact and ambiguous tool names unchanged", async () => {
		const source = createAssistantMessageEventStream();
		const wrapped = normalizeToolNameStream(source, [{ name: "Bash" }, { name: "foo" }, { name: "Foo" }]);

		source.push({
			type: "done",
			reason: "toolUse",
			message: assistantWithToolCalls(["Bash", "FOO"]),
		});

		const result = await wrapped.result();
		assert.deepEqual(toolCallNames(result), ["Bash", "FOO"]);
	});
});

function assistantWithToolCalls(names: string[]) {
	return {
		role: "assistant" as const,
		content: names.map((name, index) => ({
			type: "toolCall" as const,
			id: `call-${index}`,
			name,
			arguments: {},
		})),
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse" as const,
		timestamp: 1,
	};
}

function toolCallNames(message: AssistantMessage): string[] {
	return message.content.flatMap((item) => (item.type === "toolCall" ? [item.name] : []));
}

async function collectEvents(stream: ReturnType<typeof normalizeToolNameStream>) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}
