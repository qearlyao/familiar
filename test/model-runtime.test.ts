import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config/index.js";
import {
	assertModelCanAuthenticateWithRuntime,
	createModelRuntime,
	refreshModelCatalogs,
} from "../src/models/runtime.js";
import { parseModelRef, resolveModel, supportedThinkingLevels } from "../src/models/index.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createWorkspace } from "./helpers.js";

describe("model runtime auth storage", () => {
	it("refreshes and restores model metadata from the workspace cache", async (t) => {
		const workspace = await createWorkspace(t, '[agent]\nmodel = "anthropic/claude-sonnet-4-5"\n');
		const config = await loadConfig(workspace);
		const runtime = await createModelRuntime(config);
		await runtime.setRuntimeApiKey("openrouter", "test-key");
		await runtime.setRuntimeApiKey("anthropic", "test-key");
		const catalogModel = {
			...runtime.getModel("openrouter", "anthropic/claude-opus-5")!,
			id: "anthropic/claude-opus-5.5",
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
		};
		t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
			const provider = new URL(String(input)).pathname.split("/").at(-1);
			assert.ok(provider === "openrouter" || provider === "anthropic");
			return Response.json(
				[{ ...catalogModel, provider, id: provider === "anthropic" ? "claude-opus-5-5" : catalogModel.id }],
				{ headers: { "last-modified": "Wed, 23 Sep 2026 00:00:00 GMT" } },
			);
		});
		const result = await runtime.refresh({ providers: ["openrouter", "anthropic"], allowNetwork: true, force: true });
		assert.equal(result.errors.size, 0);
		const restored = await createModelRuntime(config);
		const ref = parseModelRef("openrouter/anthropic/claude-opus-5.5")!;
		for (const catalog of [runtime, restored]) {
			assert.ok(catalog.getModel("anthropic", "claude-opus-5-5"));
			const model = resolveModel(ref, config, catalog);
			assert.deepEqual(supportedThinkingLevels(model), ["low", "medium", "high", "xhigh", "max"]);
			assert.equal(model.maxTokens, 128000);
			assert.deepEqual(model.compat, catalogModel.compat);
		}
		assert.match(await readFile(resolve(config.workspace.dataDir, "models-store.json"), "utf8"), /claude-opus-5.5/);
	});

	it("surfaces refresh failures and timeouts", async () => {
		const runtime = {
			refresh: async () => ({ aborted: false, errors: new Map([["openrouter", new Error("HTTP 503")]]) }),
		};
		await assert.rejects(refreshModelCatalogs(runtime as unknown as ModelRuntime), /openrouter: HTTP 503/);
		runtime.refresh = async () => ({ aborted: true, errors: new Map() });
		await assert.rejects(refreshModelCatalogs(runtime as unknown as ModelRuntime), /timed out/);
	});

	it("updates OAuth request identity without changing API-key requests", async (t) => {
		const workspace = await createWorkspace(
			t,
			'[agent]\nmodel = "anthropic/claude-sonnet-4-5"\n[models.api_key_envs]\nanthropic = "FAMILIAR_TEST_ANTHROPIC_KEY"\n',
		);
		const config = await loadConfig(workspace);
		const runtime = await createModelRuntime(config);
		const model = runtime.getModel("anthropic", "claude-sonnet-4-5")!;
		for (const apiKey of ["sk-ant-oat-test", "sk-ant-api-test"]) {
			for (const simple of [true, false]) {
				let userAgent: string | null = null;
				const options = {
					apiKey,
					maxRetries: 0,
					fetch: async (_input: string | URL | Request, init?: RequestInit) => {
						userAgent = new Headers(init?.headers).get("user-agent");
						return Response.json(
							{ type: "error", error: { type: "invalid_request_error", message: "test response" } },
							{ status: 400 },
						);
					},
				};
				const context = { messages: [{ role: "user" as const, content: "hello", timestamp: Date.now() }] };
				await (simple
					? runtime.streamSimple(model, context, options)
					: runtime.stream(model, context, options)
				).result();
				assert.ok(userAgent);
				if (apiKey.includes("oat")) assert.equal(userAgent, "claude-cli/2.1.280");
				else assert.doesNotMatch(userAgent, /claude-cli/);
			}
		}
	});
	it("stores custom provider credentials in the Familiar workspace", async (t) => {
		const workspacePath = await createWorkspace(
			t,
			`
[discord]
owner_id = "owner"

[agent]
model = "proxy/test-model"

[models.base_urls]
proxy = "https://proxy.example.test/v1"

[models.api_key_envs]
proxy = "PROXY_API_KEY"

[models.providers.proxy]
api = "openai-completions"
`,
		);
		const config = await loadConfig(workspacePath);
		const runtime = await createModelRuntime(config);

		await runtime.login("proxy", "api_key", {
			prompt: async () => "workspace-secret",
			notify: () => {},
		});
		await assertModelCanAuthenticateWithRuntime(config, runtime, {
			provider: "proxy",
			id: "test-model",
			api: "openai-completions",
			baseUrl: "https://proxy.example.test/v1",
		} as any);

		assert.deepEqual(JSON.parse(await readFile(resolve(workspacePath, "auth.json"), "utf8")), {
			proxy: { type: "api_key", key: "workspace-secret" },
		});
	});
});
