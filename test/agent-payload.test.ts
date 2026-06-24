import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Model } from "@earendil-works/pi-ai/compat";

import { __agentTest } from "../src/agent/factory.js";
import { buildAnthropicMetadata } from "../src/agent/session-helpers.js";
import { createWorkspace, minimalConfigToml, withDiscordToken } from "./helpers.js";
import { loadConfig } from "../src/config/index.js";

const anthropicModel = {
	id: "claude-test",
	api: "anthropic-messages",
	provider: "anthropic",
} as Model<any>;

describe("provider payload normalization", () => {
	it("filters only the noisy Google Vertex auth debug note", () => {
		assert.equal(
			__agentTest.isNoisyProviderDebug([
				"The user provided project/location will take precedence over the API key from the environment variables.",
			]),
			true,
		);
		assert.equal(__agentTest.isNoisyProviderDebug(["different debug note"]), false);
		assert.equal(__agentTest.isNoisyProviderDebug(["debug note", { provider: "google-vertex" }]), false);
	});

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

	it("adds Anthropic user metadata from the configured owner id", async (t) => {
		const workspacePath = await createWorkspace(
			{
				after(fn) {
					t.after(fn);
				},
			},
			minimalConfigToml(),
		);
		await withDiscordToken(async () => {
			const config = await loadConfig(workspacePath);
			assert.deepEqual(buildAnthropicMetadata(config, anthropicModel), { user_id: "owner" });
			assert.equal(buildAnthropicMetadata(config, { ...anthropicModel, api: "openai-responses" }), undefined);
		});
	});
});
