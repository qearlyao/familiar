import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { Config } from "../src/config.js";

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

export function configWithDataDir(dataDir: string): Config {
	return {
		workspacePath: dataDir,
		discord: {
			token: "token",
			ownerId: "owner",
			allowedChannels: [],
			replyMode: "plain",
			chunkMode: "paragraph",
			dmMode: "steer",
			channelMode: "collect",
			channelTrigger: "mention",
			collectDebounceMs: 4000,
			allowBotMessages: false,
		},
		web: {
			port: 8787,
			authMode: "tailscale-only",
			bindAddress: "127.0.0.1",
		},
		agent: {
			model: "anthropic/claude-sonnet-4-5",
			cacheRetention: "long",
			thinkingLevel: "medium",
		},
		models: {
			allow: [],
			baseUrls: {},
			apiKeyEnvs: {},
		},
		tts: {
			provider: "elevenlabs",
			apiKeyEnv: "ELEVENLABS_API_KEY",
			voiceId: "",
			modelId: "eleven_multilingual_v2",
			outputFormat: "mp3_44100_128",
			maxInputChars: 5000,
		},
		persona: {
			soul: "SOUL.md",
			user: "USER.md",
			memory: "MEMORY.md",
		},
		workspace: {
			dataDir,
		},
	};
}
