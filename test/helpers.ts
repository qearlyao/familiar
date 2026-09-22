import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";

import { type Config, loadConfig } from "../src/config/index.js";

export type TestAfter = { after(fn: () => void | Promise<void>): void };

export async function withEnv<T>(name: string, value: string, run: () => Promise<T>): Promise<T> {
	const previous = process.env[name];
	process.env[name] = value;
	try {
		return await run();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

export async function withoutEnv<T>(name: string, run: () => Promise<T>): Promise<T> {
	const previous = process.env[name];
	delete process.env[name];
	try {
		return await run();
	} finally {
		if (previous !== undefined) process.env[name] = previous;
	}
}

export function withDiscordToken<T>(run: () => Promise<T>): Promise<T> {
	return withEnv("DISCORD_TOKEN", "discord-token", run);
}

type ConfigOverrides = Partial<{
	[K in Exclude<keyof Config, "data" | "heartbeat" | "cron" | "memory" | "browser" | "imageGen">]: Partial<
		Config[K]
	>;
}> & {
	data?: {
		chat?: Partial<Config["data"]["chat"]>;
		transcripts?: Partial<Config["data"]["transcripts"]>;
		payloads?: Partial<Config["data"]["payloads"]>;
	};
	heartbeat?: Partial<Config["heartbeat"]>;
	cron?: Partial<Config["cron"]>;
	browser?: Partial<Config["browser"]>;
	imageGen?: Partial<Config["imageGen"]>;
	memory?: Omit<Partial<Config["memory"]>, "embedding" | "lcm"> & {
		embedding?: Partial<Config["memory"]["embedding"]>;
		lcm?: Partial<Config["memory"]["lcm"]>;
	};
};

export async function createWorkspace(t: TestAfter, configToml: string): Promise<string> {
	const workspacePath = await mkdtemp(resolve(tmpdir(), "familiar-test-"));
	t.after(() => rm(workspacePath, { recursive: true, force: true }));
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

export async function createTempDataDir(t: TestAfter): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "familiar-data-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

export async function configWithDataDir(
	t: TestAfter,
	dataDir: string,
	overrides: ConfigOverrides = {},
): Promise<Config> {
	return withDiscordToken(async () => {
		const workspacePath = await createWorkspace(
			t,
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
			qq: { ...config.qq, ...overrides.qq },
			web: { ...config.web, ...overrides.web },
			browser: { ...config.browser, ...overrides.browser },
			agent: { ...config.agent, ...overrides.agent },
			heartbeat: { ...config.heartbeat, ...overrides.heartbeat },
			cron: { ...config.cron, ...overrides.cron },
			mcp: { ...config.mcp, ...overrides.mcp },
			tools: { ...config.tools, ...overrides.tools },
			models: { ...config.models, ...overrides.models },
			tts: { ...config.tts, ...overrides.tts },
			imageGen: { ...config.imageGen, ...overrides.imageGen },
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
	});
}

/** A JSON request body as the web route handlers read it. */
export function jsonRequest(body: unknown, method = "POST"): IncomingMessage {
	const request = Readable.from([JSON.stringify(body)]) as Readable & { headers: Record<string, string>; method: string };
	request.headers = { "content-type": "application/json" };
	request.method = method;
	return request as unknown as IncomingMessage;
}

/** Just enough of a ServerResponse to capture what a route or static handler sends. */
export class FakeResponse {
	statusCode?: number;
	headers?: Record<string, string>;
	body = "";

	writeHead(statusCode: number, headers?: Record<string, string>): void {
		this.statusCode = statusCode;
		this.headers = headers;
	}

	write(chunk: string | Buffer): void {
		this.body += chunk.toString();
	}

	end(chunk?: string | Buffer): void {
		if (chunk) this.write(chunk);
	}

	on(): this {
		return this;
	}

	once(): this {
		return this;
	}

	emit(): boolean {
		return true;
	}
}
