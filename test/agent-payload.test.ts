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

	it("moves Anthropic cache_control off a trailing injected-memory note onto the stable message", () => {
		const note = {
			role: "system",
			content: [
				{ type: "text", text: "<injected_memory>\n1. 2026-05-12: diary\n</injected_memory>", cache_control: { type: "ephemeral" } },
			],
		};
		const typed = { role: "user", content: [{ type: "text", text: "what did you see?" }] };
		const plain = { role: "user", content: "what did you see?" };

		const blocks = __agentTest.normalizeProviderPayload(
			{ messages: [typed, structuredClone(note)] },
			anthropicModel,
		) as { messages: { content: { cache_control?: unknown }[] }[] };
		assert.deepEqual(blocks.messages[0]?.content[0]?.cache_control, { type: "ephemeral" });
		assert.equal("cache_control" in (blocks.messages[1]?.content[0] ?? {}), false);

		const text = __agentTest.normalizeProviderPayload(
			{ messages: [plain, structuredClone(note)] },
			anthropicModel,
		) as { messages: { content: unknown }[] };
		assert.deepEqual(text.messages[0]?.content, [
			{ type: "text", text: "what did you see?", cache_control: { type: "ephemeral" } },
		]);
	});

	it("moves a system note that no user turn precedes onto the user role", () => {
		const heartbeat = { role: "system", content: "<heartbeat>\nnobody has spoken in a while\n</heartbeat>" };
		const effort = { role: "system", content: [], output_config: { effort: "high" } };
		const assistant = { role: "assistant", content: [{ type: "text", text: "hello" }] };
		const typed = { role: "user", content: [{ type: "text", text: "typed prompt" }] };
		const note = { role: "system", content: [{ type: "text", text: "a call was kept" }] };

		const opened = __agentTest.normalizeProviderPayload(
			{ messages: [typed, assistant, structuredClone(heartbeat), structuredClone(effort)] },
			anthropicModel,
		) as { messages: { role: string; content: unknown }[] };
		assert.deepEqual(opened.messages[2], {
			role: "user",
			content: [{ type: "text", text: "<heartbeat>\nnobody has spoken in a while\n</heartbeat>" }],
		});
		assert.deepEqual(opened.messages[3], effort);

		// a note behind a user turn is legal; a second one behind it is not, so it moves instead
		const trailing = __agentTest.normalizeProviderPayload(
			{ messages: [assistant, typed, structuredClone(note), structuredClone(note)] },
			anthropicModel,
		) as { messages: { role: string }[] };
		assert.deepEqual(
			trailing.messages.map((message) => message.role),
			["assistant", "user", "system", "user"],
		);

		const other = { messages: [structuredClone(heartbeat)] };
		assert.equal(__agentTest.normalizeProviderPayload(other, { ...anthropicModel, api: "openai-responses" }), other);
		assert.equal(other.messages[0]?.role, "system");
	});

	it("moves Anthropic cache_control past a trailing effort directive", () => {
		const typed = { role: "user", content: [{ type: "text", text: "what did you see?" }] };
		const note = {
			role: "system",
			content: [{ type: "text", text: "<injected_memory>\n1. 2026-05-12: diary\n</injected_memory>", cache_control: { type: "ephemeral" } }],
		};
		const effort = { role: "system", content: [], output_config: { effort: "high" } };

		const payload = __agentTest.normalizeProviderPayload(
			{ messages: [typed, note, effort] },
			anthropicModel,
		) as { messages: { content: { cache_control?: unknown }[] }[] };
		assert.deepEqual(payload.messages[0]?.content[0]?.cache_control, { type: "ephemeral" });
		assert.equal("cache_control" in (payload.messages[1]?.content[0] ?? {}), false);
	});

	it("adds OpenRouter routing to Anthropic Messages and OpenAI Completions", () => {
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

		assert.deepEqual(
			__agentTest.normalizeProviderPayload(
				{ model: "anthropic/claude-sonnet-4", messages: [] },
				{
					id: "anthropic/claude-sonnet-4",
					api: "openai-completions",
					provider: "openrouter",
					baseUrl: "https://openrouter.ai/api/v1",
				} as Model<any>,
				routing,
			),
			{
				model: "anthropic/claude-sonnet-4",
				messages: [],
				provider: { order: ["anthropic"], allow_fallbacks: true },
			},
		);
		assert.throws(
			() =>
				__agentTest.normalizeProviderPayload(
					{ input: [] },
					{
						id: "gpt-5",
						api: "openai-responses",
						provider: "openrouter",
						baseUrl: "https://openrouter.ai/api/v1",
					} as Model<any>,
					routing,
				),
			/requires anthropic-messages or openai-completions/,
		);
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
