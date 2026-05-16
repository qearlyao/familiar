import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { type Config, loadConfig } from "../src/config.js";

type ConfigOverrides = Partial<{
	[K in Exclude<keyof Config, "data" | "heartbeat" | "cron" | "memory" | "browser">]: Partial<Config[K]>;
}> & {
	data?: {
		chat?: Partial<Config["data"]["chat"]>;
		transcripts?: Partial<Config["data"]["transcripts"]>;
		payloads?: Partial<Config["data"]["payloads"]>;
	};
	heartbeat?: Partial<Config["heartbeat"]>;
	cron?: Partial<Config["cron"]>;
	browser?: Partial<Config["browser"]>;
	memory?: Omit<Partial<Config["memory"]>, "embedding" | "lcm"> & {
		embedding?: Partial<Config["memory"]["embedding"]>;
		lcm?: Partial<Config["memory"]["lcm"]>;
	};
};

export async function createWorkspace(configToml: string): Promise<string> {
	const workspacePath = await mkdtemp(resolve(tmpdir(), "familiar-test-"));
	await writeFile(resolve(workspacePath, "config.toml"), configToml, "utf8");
	await writeFile(resolve(workspacePath, "SOUL.md"), "# Soul\n", "utf8");
	await writeFile(resolve(workspacePath, "USER.md"), "# User\n", "utf8");
	await writeFile(resolve(workspacePath, "MEMORY.md"), "# Memory\n", "utf8");
	return workspacePath;
}

export function minimalConfigToml(extra = ""): string {
	return `
[discord]
owner_id = "owner"

[agent]
model = "anthropic/claude-sonnet-4-5"

${extra}
`;
}

export async function createTempDataDir(): Promise<string> {
	return mkdtemp(resolve(tmpdir(), "familiar-data-"));
}

export async function configWithDataDir(
	dataDir: string,
	overrides: ConfigOverrides = {},
): Promise<Config> {
	const previousDiscordToken = process.env.DISCORD_TOKEN;
	process.env.DISCORD_TOKEN = "discord-token";
	try {
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[workspace]
data_dir = "${dataDir.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"
`),
		);
		const config = await loadConfig(workspacePath);
		return {
			...config,
			...overrides,
			discord: { ...config.discord, ...overrides.discord },
			web: { ...config.web, ...overrides.web },
			browser: { ...config.browser, ...overrides.browser },
			agent: { ...config.agent, ...overrides.agent },
			heartbeat: { ...config.heartbeat, ...overrides.heartbeat },
			cron: { ...config.cron, ...overrides.cron },
			models: { ...config.models, ...overrides.models },
			tts: { ...config.tts, ...overrides.tts },
			mediaUnderstanding: {
				audio: { ...config.mediaUnderstanding.audio, ...overrides.mediaUnderstanding?.audio },
				video: { ...config.mediaUnderstanding.video, ...overrides.mediaUnderstanding?.video },
			},
			persona: { ...config.persona, ...overrides.persona },
			media: { ...config.media, ...overrides.media },
			data: {
				chat: { ...config.data.chat, ...overrides.data?.chat },
				transcripts: { ...config.data.transcripts, ...overrides.data?.transcripts },
				payloads: { ...config.data.payloads, ...overrides.data?.payloads },
			},
			workspace: { ...config.workspace, ...overrides.workspace, dataDir },
			memory: {
				...config.memory,
				...overrides.memory,
				embedding: { ...config.memory.embedding, ...overrides.memory?.embedding },
				lcm: { ...config.memory.lcm, ...overrides.memory?.lcm },
			},
		};
	} finally {
		if (previousDiscordToken === undefined) delete process.env.DISCORD_TOKEN;
		else process.env.DISCORD_TOKEN = previousDiscordToken;
	}
}
