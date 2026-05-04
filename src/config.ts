import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { parse } from "smol-toml";

export type CacheRetention = "none" | "short" | "long";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface Config {
	workspacePath: string;
	discord: {
		token: string;
		ownerId: string;
		allowedChannels: string[];
	};
	agent: {
		api: string;
		modelId: string;
		baseUrl: string;
		apiKeyEnv: string;
		provider: string;
		cacheRetention: CacheRetention;
		thinkingLevel: ThinkingLevel;
	};
	models: {
		allow: string[];
		baseUrls: Record<string, string>;
		apiKeyEnvs: Record<string, string>;
	};
	persona: {
		soul: string;
		user: string;
		memory: string;
	};
	workspace: {
		dataDir: string;
	};
}

function interpolateEnv(value: string): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
		return process.env[name] ?? fallback ?? "";
	});
}

function interpolateValue(value: unknown): unknown {
	if (typeof value === "string") return interpolateEnv(value);
	if (Array.isArray(value)) return value.map(interpolateValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, interpolateValue(child)]));
	}
	return value;
}

function readString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Missing required config value: ${path}`);
	}
	return value;
}

function readOptionalString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function readStringArray(value: unknown, path: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`Config value must be a string array: ${path}`);
	}
	return value;
}

function readStringRecord(value: unknown, path: string): Record<string, string> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Config value must be a string map: ${path}`);
	}
	const entries = Object.entries(value);
	for (const [key, child] of entries) {
		if (typeof child !== "string") throw new Error(`Config value must be a string map: ${path}.${key}`);
	}
	return Object.fromEntries(entries) as Record<string, string>;
}

function readCacheRetention(value: unknown): CacheRetention {
	if (value === "none" || value === "short" || value === "long") return value;
	throw new Error('Config value agent.cacheRetention must be one of "none", "short", or "long"');
}

function readThinkingLevel(value: unknown): ThinkingLevel {
	if (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	) {
		return value;
	}
	throw new Error(
		'Config value agent.thinking_level must be one of "off", "minimal", "low", "medium", "high", or "xhigh"',
	);
}

function resolveWorkspacePath(workspacePath: string, filePath: string): string {
	return isAbsolute(filePath) ? filePath : resolve(workspacePath, filePath);
}

export async function loadConfig(workspacePathInput: string): Promise<Config> {
	const workspacePath = resolve(workspacePathInput);
	const configPath = resolve(workspacePath, "config.toml");
	if (!existsSync(configPath)) {
		throw new Error(`Missing config.toml in workspace: ${workspacePath}`);
	}

	const raw = await readFile(configPath, "utf8");
	const parsed = interpolateValue(parse(raw)) as Record<string, any>;

	const discord = (parsed.discord ?? {}) as Record<string, unknown>;
	const agent = (parsed.agent ?? {}) as Record<string, unknown>;
	const models = (parsed.models ?? {}) as Record<string, unknown>;
	const persona = (parsed.persona ?? {}) as Record<string, unknown>;
	const workspace = (parsed.workspace ?? {}) as Record<string, unknown>;

	const ownerId = readString(discord.owner_id, "discord.owner_id");
	const api = readString(agent.api, "agent.api");
	const modelId = readString(agent.model_id, "agent.model_id");
	const baseUrl = readString(agent.base_url, "agent.base_url");
	const apiKeyEnv = readString(agent.api_key_env, "agent.api_key_env");
	const provider = readOptionalString(agent.provider, "custom");

	return {
		workspacePath,
		discord: {
			token: readString(process.env.DISCORD_TOKEN, "DISCORD_TOKEN"),
			ownerId,
			allowedChannels: readStringArray(discord.allowed_channels, "discord.allowed_channels"),
		},
		agent: {
			api,
			modelId,
			baseUrl,
			apiKeyEnv,
			provider,
			cacheRetention: readCacheRetention(readOptionalString(agent.cacheRetention, "long")),
			thinkingLevel: readThinkingLevel(readOptionalString(agent.thinking_level, "medium")),
		},
		models: {
			allow: readStringArray(models.allow, "models.allow"),
			baseUrls: readStringRecord(models.base_urls, "models.base_urls"),
			apiKeyEnvs: readStringRecord(models.api_key_envs, "models.api_key_envs"),
		},
		persona: {
			soul: resolveWorkspacePath(workspacePath, readOptionalString(persona.soul, "SOUL.md")),
			user: resolveWorkspacePath(workspacePath, readOptionalString(persona.user, "USER.md")),
			memory: resolveWorkspacePath(workspacePath, readOptionalString(persona.memory, "MEMORY.md")),
		},
		workspace: {
			dataDir: resolveWorkspacePath(workspacePath, readOptionalString(workspace.data_dir, "data")),
		},
	};
}
