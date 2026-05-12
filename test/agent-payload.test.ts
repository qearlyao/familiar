import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Model } from "@earendil-works/pi-ai";

import { __agentTest } from "../src/agent.js";

const anthropicModel = {
	id: "claude-test",
	api: "anthropic-messages",
	provider: "anthropic",
} as Model<any>;

describe("provider payload normalization", () => {
	it("keeps Anthropic cache_control on stable user text before injected memory", () => {
		const payload = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "what did you see?" },
						{
							type: "text",
							text: "<injected_memory>\n1. 2026-05-12: diary\n</injected_memory>",
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
		};

		const normalized = __agentTest.normalizeProviderPayload(payload, anthropicModel) as typeof payload;
		const content = normalized.messages[0]?.content;

		assert.deepEqual(content?.[0]?.cache_control, { type: "ephemeral" });
		assert.equal(content?.[1] && "cache_control" in content[1], false);
	});
});
