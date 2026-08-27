import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Model } from "@earendil-works/pi-ai/compat";

import { __agentTest } from "../src/agent/factory.js";
import { buildAnthropicMetadata } from "../src/agent/session-helpers.js";
import { modelRuntimeEnv } from "../src/models/runtime.js";
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

	it("adds OpenRouter routing only to its Anthropic Messages endpoint", () => {
		const routing = { order: ["anthropic"], allowFallbacks: true };
		const openRouterModel = { ...anthropicModel, baseUrl: "https://openrouter.ai/api/" };
		const payload = { messages: [] };

		assert.deepEqual(__agentTest.normalizeProviderPayload(payload, openRouterModel, routing), {
			messages: [],
			provider: { order: ["anthropic"], allow_fallbacks: true },
		});

		for (const baseUrl of [
			"https://api.anthropic.com",
			"https://proxy.example.test",
			"https://openrouter.ai.evil.example/api",
			"http://openrouter.ai/api",
			"https://openrouter.ai/api/v1",
		]) {
			const untouched = { messages: [] };
			assert.equal(__agentTest.normalizeProviderPayload(untouched, { ...anthropicModel, baseUrl }), untouched);
			assert.equal("provider" in untouched, false);
			assert.throws(
				() => __agentTest.normalizeProviderPayload({ messages: [] }, { ...anthropicModel, baseUrl }, routing),
				/OpenRouter routing requires https:\/\/openrouter\.ai\/api/,
			);
		}
	});

	it("adds Anthropic user metadata from the configured owner id regardless of auth mode", async (t) => {
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

	it("maps Familiar model-specific API key env names into runtime env", async (t) => {
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[models.api_key_envs]
"openai/gpt-6" = "FAMILIAR_OPENAI_KEY"
`),
		);
		const config = await loadConfig(workspacePath);
		const model = { id: "gpt-6", api: "openai-responses", provider: "openai" } as Model<any>;
		const previous = process.env.FAMILIAR_OPENAI_KEY;
		process.env.FAMILIAR_OPENAI_KEY = "secret";
		try {
			assert.deepEqual(modelRuntimeEnv(config, model), { FAMILIAR_OPENAI_KEY: "secret" });
		} finally {
			if (previous === undefined) delete process.env.FAMILIAR_OPENAI_KEY;
			else process.env.FAMILIAR_OPENAI_KEY = previous;
		}
	});
});
