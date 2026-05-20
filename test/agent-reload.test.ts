import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { createFamiliarAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { loadSettingsStore } from "../src/settings.js";
import { createTempDataDir, createWorkspace, minimalConfigToml } from "./helpers.js";

async function withEnv(name: string, value: string, run: () => Promise<void>): Promise<void> {
	const previous = process.env[name];
	process.env[name] = value;
	try {
		await run();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

async function withoutEnv(name: string, run: () => Promise<void>): Promise<void> {
	const previous = process.env[name];
	delete process.env[name];
	try {
		await run();
	} finally {
		if (previous !== undefined) process.env[name] = previous;
	}
}

describe("FamiliarAgent reload", () => {
	it("keeps the previous live config when reload validation fails", async () => {
		await withEnv("ANTHROPIC_API_KEY", "test-key", async () => {
			await withoutEnv("OPENAI_API_KEY", async () => {
				const previousDiscordToken = process.env.DISCORD_TOKEN;
				process.env.DISCORD_TOKEN = "discord-token";
				try {
					const dataDir = await createTempDataDir();
					const workspacePath = await createWorkspace(
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
				} finally {
					if (previousDiscordToken === undefined) delete process.env.DISCORD_TOKEN;
					else process.env.DISCORD_TOKEN = previousDiscordToken;
				}
			});
		});
	});

	it("reapplies config overrides after reload rebuilds the base config", async () => {
		await withEnv("ANTHROPIC_API_KEY", "test-key", async () => {
			const previousDiscordToken = process.env.DISCORD_TOKEN;
			process.env.DISCORD_TOKEN = "discord-token";
			try {
				const dataDir = await createTempDataDir();
				const workspacePath = await createWorkspace(
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
			} finally {
				if (previousDiscordToken === undefined) delete process.env.DISCORD_TOKEN;
				else process.env.DISCORD_TOKEN = previousDiscordToken;
			}
		});
	});
});
