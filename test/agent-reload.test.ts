import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { createFamiliarAgent } from "../src/agent/factory.js";
import { loadConfig } from "../src/config/index.js";
import { loadSettingsStore } from "../src/config/settings.js";
import { createTempDataDir, createWorkspace, minimalConfigToml, withDiscordToken, withEnv, withoutEnv } from "./helpers.js";

describe("FamiliarAgent reload", () => {
	it("keeps the previous live config when reload validation fails", async (t) => {
		await withEnv("ANTHROPIC_API_KEY", "test-key", async () => {
			await withoutEnv("OPENAI_API_KEY", async () => {
				await withDiscordToken(async () => {
					const dataDir = await createTempDataDir(t);
					const workspacePath = await createWorkspace(
						t,
						minimalConfigToml(`
[workspace]
data_dir = "${dataDir.replaceAll("\\", "\\\\")}"

[models]
allow = ["anthropic/claude-sonnet-4-5", "openai/gpt-5.2"]
`),
					);
					const config = await loadConfig(workspacePath);
					const settings = await loadSettingsStore(config);
					let nextConfig = config;
					const agent = await createFamiliarAgent(config, settings, undefined, {
						reloadConfig: async () => nextConfig,
					});

					assert.equal(agent.getModel("web").value, "anthropic/claude-sonnet-4-5");
					await writeFile(
						resolve(workspacePath, "config.toml"),
						`
[discord]
owner_id = "owner"

[workspace]
data_dir = "${dataDir.replaceAll("\\", "\\\\")}"

[agent]
model = "openai/gpt-5.2"

[models]
allow = ["anthropic/claude-sonnet-4-5", "openai/gpt-5.2"]
`,
						"utf8",
					);
					nextConfig = await loadConfig(workspacePath);

					await assert.rejects(() => agent.reload(), /Missing API key for openai\/gpt-5\.2/);
					assert.equal(agent.getModel("web").value, "anthropic/claude-sonnet-4-5");
				});
			});
		});
	});

	it("reapplies config overrides after reload rebuilds the base config", async (t) => {
		await withEnv("ANTHROPIC_API_KEY", "test-key", async () => {
			await withDiscordToken(async () => {
				const dataDir = await createTempDataDir(t);
				const workspacePath = await createWorkspace(
					t,
					minimalConfigToml(`
[workspace]
data_dir = "${dataDir.replaceAll("\\", "\\\\")}"
`),
				);
				await mkdir(resolve(dataDir, "settings"), { recursive: true });
				await writeFile(
					resolve(dataDir, "settings", "config-overrides.json"),
					JSON.stringify({ "heartbeat.enabled": true }, null, 2),
					"utf8",
				);
				const config = await loadConfig(workspacePath);
				const settings = await loadSettingsStore(config);
				const agent = await createFamiliarAgent(config, settings, undefined, {
					reloadConfig: async () => loadConfig(workspacePath),
				});

				assert.equal(config.heartbeat.enabled, true);
				await agent.reload();
				assert.equal(config.heartbeat.enabled, true);
			});
		});
	});
});
