import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import {
	createAgentMessageFingerprint,
	createRawContextItems,
	estimateAgentMessageTokens,
	estimateLcmRecordTokens,
	estimateTextTokens,
	lcmRecordToAgentMessage,
	selectLcmCompactionCandidatePromptAware,
} from "../src/memory/lcm/context.js";
import { buildCondensedSummaryPrompt, buildLeafSummaryPrompt, capSummaryText } from "../src/memory/lcm/summarizer.js";
import type {
	LcmRecordKind,
	LcmSourceProvenance,
	StoredLcmRecord,
} from "../src/memory/lcm/types.js";

const source: LcmSourceProvenance = {
	sourceType: "chat",
	sourceRef: "chat:test",
};

describe("LCM context helpers", () => {
	it("uses companion-oriented prompts and depth-aware condensed prompts", () => {
		const leaf = buildLeafSummaryPrompt({
			text: "The user felt overwhelmed but wanted help planning tomorrow.",
			mode: "normal",
			targetTokens: 120,
		});
		assert.match(leaf, /companion conversation/);
		assert.match(leaf, /stay close to the user/);
		assert.match(leaf, /what's still open between them/);
		assert.doesNotMatch(leaf, /Files: none/);

		const d2 = buildCondensedSummaryPrompt({
			text: "leaf one\nleaf two",
			targetTokens: 120,
			depth: 2,
			childSummaryCount: 2,
		});
		assert.match(d2, /session-level continuity memory/);
		const d3 = buildCondensedSummaryPrompt({
			text: "session one\nsession two",
			targetTokens: 120,
			depth: 3,
			childSummaryCount: 2,
		});
		assert.match(d3, /trajectory-level continuity memory/);
	});

	it("caps oversized summaries with a deterministic fallback marker", () => {
		const capped = capSummaryText("important detail ".repeat(200), 20);
		assert.ok(capped.length < "important detail ".repeat(200).length);
		assert.match(capped, /Compressed away: overflow beyond summary cap/);
	});

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

	it("counts replay signatures on assistant content blocks", () => {
		const base = assistantMessage([
			{ type: "text", text: "I see it." },
			{ type: "thinking", thinking: "check the plan" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "PLAN.md" } },
		]);
		const withSignatures = assistantMessage([
			{ type: "text", text: "I see it.", textSignature: "sig-text ".repeat(12) },
			{ type: "thinking", thinking: "check the plan", thinkingSignature: "sig-thinking ".repeat(12) },
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "PLAN.md" },
				thoughtSignature: "sig-thought ".repeat(12),
			},
		]);

		assert.ok(estimateAgentMessageTokens(withSignatures) > estimateAgentMessageTokens(base));
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
		const unsigned = lcmRecordToAgentMessage({
			...record(1, "assistant", "[tool_call: read({\"path\":\"PLAN.md\"})]"),
			parts: [
				{ kind: "text", text: "I'll check." },
				{ kind: "thinking", text: "Need the current plan." },
				{ kind: "tool_call", toolCallId: "call-1", toolName: "read", arguments: { path: "PLAN.md" } },
			],
		});
		const message = lcmRecordToAgentMessage({
			...record(1, "assistant", "[tool_call: read({\"path\":\"PLAN.md\"})]"),
			parts: [
				{ kind: "text", text: "I'll check.", signature: "sig-text ".repeat(12) },
				{ kind: "thinking", text: "Need the current plan.", signature: "sig-thinking ".repeat(12) },
				{
					kind: "tool_call",
					toolCallId: "call-1",
					toolName: "read",
					arguments: { path: "PLAN.md" },
					signature: "sig-thought ".repeat(12),
				},
			],
		});

		assert.equal(message.role, "assistant");
		assert.deepEqual(message.content, [
			{ type: "text", text: "I'll check.", textSignature: "sig-text ".repeat(12) },
			{ type: "thinking", thinking: "Need the current plan.", thinkingSignature: "sig-thinking ".repeat(12) },
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "PLAN.md" },
				thoughtSignature: "sig-thought ".repeat(12),
			},
		]);
		assert.ok(estimateAgentMessageTokens(message) > estimateAgentMessageTokens(unsigned));
	});

	it("prompt-aware candidate selection preserves tool_call and tool_result pair integrity", () => {
		const toolCall = record(1, "assistant", "[tool_call: read({\"path\":\"PLAN.md\"})]");
		const toolResult = record(2, "tool", "[tool_result: read -> unrelated weather output]");
		const rebar = record(3, "user", "rebar lattice anchor bolts and sleeve details");
		const other = record(4, "user", "kanban schedule board cleanup");
		const fresh = record(5, "user", "fresh rebar lattice question");
		const items = [
			rawItem(toolCall, {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "PLAN.md" } }],
				api: "test",
				provider: "test",
				model: "test",
				usage: zeroUsage(),
				stopReason: "toolUse",
				timestamp: 1,
			}),
			rawItem(toolResult, {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "unrelated weather output" }],
				details: { text: "unrelated weather output" },
				isError: false,
				timestamp: 2,
			}),
			rawItem(rebar, { role: "user", content: rebar.text, timestamp: 3 }),
			rawItem(other, { role: "user", content: other.text, timestamp: 4 }),
			rawItem(fresh, { role: "user", content: fresh.text, timestamp: 5 }),
		];

		const candidate = selectLcmCompactionCandidatePromptAware(
			items,
			{
				contextThreshold: 0.75,
				freshTailCount: 1,
				leafChunkTokens: 12,
				promptAwareEvictionEnabled: true,
			},
			10_000,
			"rebar lattice details",
		);

		assert.deepEqual(
			candidate.chunk.map((item) => item.record?.id),
			[1, 2],
		);
	});

	it("signature-aware assistant estimates can affect leaf chunk compaction", () => {
		const signedAssistantRecord = record(1, "assistant", "structured assistant reply");
		const signedAssistant = assistantMessage([
			{ type: "text", text: "structured assistant reply", textSignature: "sig-text ".repeat(20) },
			{ type: "thinking", thinking: "internal note", thinkingSignature: "sig-thinking ".repeat(20) },
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "PLAN.md" },
				thoughtSignature: "sig-thought ".repeat(20),
			},
		]);
		const userRecord = record(2, "user", "leaf trigger prompt");
		const items = [
			rawItem(signedAssistantRecord, signedAssistant),
			rawItem(userRecord, { role: "user", content: userRecord.text, timestamp: 2 }),
		];

		const withSignatures = selectLcmCompactionCandidatePromptAware(
			items,
			{
				contextThreshold: 0.9,
				freshTailCount: 0,
				leafChunkTokens: 50,
				promptAwareEvictionEnabled: false,
			},
			100,
			"",
		);
		const withoutSignatures = selectLcmCompactionCandidatePromptAware(
			[
				rawItem(
					signedAssistantRecord,
					assistantMessage([
						{ type: "text", text: "structured assistant reply" },
						{ type: "thinking", thinking: "internal note" },
						{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "PLAN.md" } },
					]),
				),
				rawItem(userRecord, { role: "user", content: userRecord.text, timestamp: 2 }),
			],
			{
				contextThreshold: 0.9,
				freshTailCount: 0,
				leafChunkTokens: 50,
				promptAwareEvictionEnabled: false,
			},
			100,
			"",
		);

		assert.equal(withoutSignatures.shouldCompact, false);
		assert.equal(withSignatures.shouldCompact, true);
		assert.ok(withSignatures.rawTokensOutsideTail > withoutSignatures.rawTokensOutsideTail);
	});

	it("fresh_tail_max_tokens narrows protected tail instead of expanding it", () => {
		const items = [
			rawItem(record(1, "user", "old alpha"), { role: "user", content: "old alpha ".repeat(20), timestamp: 1 }),
			rawItem(record(2, "user", "old beta"), { role: "user", content: "old beta ".repeat(20), timestamp: 2 }),
			rawItem(record(3, "user", "old gamma"), { role: "user", content: "old gamma ".repeat(20), timestamp: 3 }),
			rawItem(record(4, "user", "fresh delta"), { role: "user", content: "fresh delta", timestamp: 4 }),
		];

		const candidate = selectLcmCompactionCandidatePromptAware(
			items,
			{
				contextThreshold: 0.75,
				freshTailCount: 4,
				freshTailMaxTokens: 20,
				leafChunkTokens: 1,
				promptAwareEvictionEnabled: false,
			},
			10_000,
			"",
		);

		assert.equal(candidate.freshTailStartIndex, 3);
		assert.equal(candidate.shouldCompact, true);
		assert.deepEqual(
			candidate.chunk.map((item) => item.record?.id),
			[1],
		);
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

function rawItem(record: StoredLcmRecord, message: AgentMessage) {
	return {
		id: `item-${record.id}`,
		message,
		record,
		tokens: estimateAgentMessageTokens(message),
	};
}

function assistantMessage(content: AssistantMessage["content"]): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: 2,
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
