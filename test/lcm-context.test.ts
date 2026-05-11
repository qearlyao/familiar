import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
	createAgentMessageFingerprint,
	createRawContextItems,
	detectLcmCompactionPressure,
	estimateAgentMessageTokens,
	estimateLcmRecordTokens,
	estimateTextTokens,
	lcmRecordToAgentMessage,
	selectFreshTailRecords,
} from "../src/memory/lcm/context.js";
import type {
	LcmRecordKind,
	LcmSourceProvenance,
	LcmSummaryStatus,
	StoredLcmRecord,
	StoredLcmSummary,
} from "../src/memory/lcm/types.js";

const source: LcmSourceProvenance = {
	sourceType: "chat",
	sourceRef: "chat:test",
};

describe("LCM context helpers", () => {
	it("estimates text and AgentMessage tokens conservatively", () => {
		assert.equal(estimateTextTokens("abcdefghijkl"), 4);
		assert.equal(estimateTextTokens("你好"), 2);

		const user: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "look at this compact toolbar" },
				{ type: "image", data: "base64", mimeType: "image/png" },
			],
			timestamp: 1,
		};
		const assistant: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "check the plan" },
				{ type: "text", text: "I see it." },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "PLAN.md" } },
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: zeroUsage(),
			stopReason: "toolUse",
			timestamp: 2,
		};

		assert.ok(estimateAgentMessageTokens(user) >= 1200);
		assert.ok(estimateAgentMessageTokens(assistant) > estimateTextTokens("I see it."));
	});

	it("estimates LCM record text with attachment notes", () => {
		const plain = estimateLcmRecordTokens(record(1, "user", "short"));
		const withAttachment = estimateLcmRecordTokens({
			...record(2, "user", "short"),
			attachments: [{ name: "sketch.png", kind: "image", note: "compact toolbar sketch" }],
		});

		assert.ok(plain > 0);
		assert.ok(withAttachment > plain);
	});

	it("protects a fresh tail by count even when the token cap is exceeded", () => {
		const records = [
			record(1, "user", "old one"),
			record(2, "assistant", "old two"),
			record(3, "tool", "ignored tool"),
			record(4, "user", "fresh " + "x".repeat(60)),
			record(5, "assistant", "fresh " + "y".repeat(60)),
		];

		const selection = selectFreshTailRecords(records, { messageCount: 2, maxTokens: 5 });

		assert.deepEqual(
			selection.records.map((item) => item.id),
			[4, 5],
		);
		assert.ok(selection.tokenCount > 5);
		assert.ok(selection.overflowTokens > 0);
	});

	it("extends the fresh tail backward until the optional token cap is reached", () => {
		const records = [
			record(1, "user", "one"),
			record(2, "assistant", "two"),
			record(3, "user", "three"),
			record(4, "assistant", "four"),
		];

		const selection = selectFreshTailRecords(records, { messageCount: 1, maxTokens: 40 });

		assert.deepEqual(
			selection.records.map((item) => item.id),
			[1, 2, 3, 4],
		);
	});

	it("detects compaction pressure from evictable tokens outside the fresh tail", () => {
		const records = [
			record(1, "user", "old " + "a".repeat(120)),
			record(2, "assistant", "old " + "b".repeat(120)),
			record(3, "boundary", "Session boundary"),
			record(4, "user", "fresh question"),
			record(5, "assistant", "fresh answer"),
		];

		const pressure = detectLcmCompactionPressure({
			records,
			summaries: [summary(1, "seg-a", 1, "ready", "Existing retained summary.")],
			freshTail: { messageCount: 2 },
			evictableTokenThreshold: 10,
			evictableTokenBudget: 1_000,
		});

		assert.equal(pressure.shouldCompact, true);
		assert.deepEqual(pressure.reasons, ["evictable_threshold"]);
		assert.equal(pressure.evictableRecordCount, 2);
		assert.equal(pressure.freshTailRecordCount, 2);
		assert.ok(pressure.evictableTokens > pressure.freshTailTokens);
		assert.ok(pressure.summaryTokens > 0);
	});

	it("creates stable AgentMessage fingerprints independent of starting index", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "first stable detail", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "second stable detail" }], api: "test", provider: "test", model: "test", usage: zeroUsage(), stopReason: "stop", timestamp: 2 },
			{ role: "user", id: "msg-3", content: "third stable detail" } as unknown as AgentMessage,
		];
		const first = messages.map((message, index) => createAgentMessageFingerprint(message, index));
		const second = messages.map((message, index) => createAgentMessageFingerprint(message, index + 42));

		assert.deepEqual(first, second);
		assert.deepEqual(
			createRawContextItems(messages).map((item) => item.id),
			first,
		);
	});

	it("lcmRecordToAgentMessage reconstructs structured content blocks from tool_call parts", () => {
		const message = lcmRecordToAgentMessage({
			...record(1, "assistant", "[tool_call: read({\"path\":\"PLAN.md\"})]"),
			parts: [
				{ kind: "thinking", text: "Need the current plan." },
				{ kind: "tool_call", toolCallId: "call-1", toolName: "read", arguments: { path: "PLAN.md" } },
			],
		});

		assert.equal(message.role, "assistant");
		assert.deepEqual(message.content, [
			{ type: "thinking", thinking: "Need the current plan." },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "PLAN.md" } },
		]);
	});
});

function record(
	id: number,
	kind: LcmRecordKind,
	text: string,
	happenedAt = `2026-05-10T00:${String(id).padStart(2, "0")}:00.000Z`,
): StoredLcmRecord {
	return {
		id,
		recordKey: `record-${id}`,
		segmentId: "seg-a",
		kind,
		text,
		parts: null,
		happenedAt,
		sessionId: "session-a",
		channelKey: "web-web-room",
		channelId: "room",
		jobId: null,
		source,
		attachments: null,
		metadata: null,
		createdAt: id,
		updatedAt: id,
	};
}

function summary(
	id: number,
	segmentId: string,
	depth: number,
	status: LcmSummaryStatus,
	text: string,
	pinned = false,
): StoredLcmSummary {
	return {
		id,
		summaryKey: `summary-${id}`,
		segmentId,
		depth,
		status,
		text,
		pinned,
		coversFromRecordId: id,
		coversToRecordId: id,
		source,
		metadata: null,
		createdAt: id,
		updatedAt: id,
	};
}

function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}
