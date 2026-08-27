import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config/index.js";
import { assertModelCanAuthenticateWithRuntime, createModelRuntime } from "../src/models/runtime.js";
import { createWorkspace } from "./helpers.js";

describe("model runtime auth storage", () => {
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
