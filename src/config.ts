import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { parse } from "smol-toml";

export type CacheRetention = "none" | "short" | "long";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type DiscordReplyMode = "plain" | "reply";
export type DiscordChunkMode = "simple" | "paragraph" | "newline";
export type DiscordDispatchMode = "steer" | "queue" | "collect";
export type DiscordChannelTrigger = "mention" | "always";
export type CronFrequency = "once" | "hourly" | "daily" | "weekly" | "monthly";
export type CronDeliveryMode = "queue" | "follow_up";
export type WebAuthMode = "tailscale-only" | "bearer" | "public-2fa";
export type TtsProvider = "elevenlabs";
export type MediaUnderstandingProvider = "groq" | "google";
export type MemoryEmbeddingFormat = "gemini" | "openai" | "voyage";

const loggedConfigWarnings = new Set<string>();

const DEFAULT_MEMORY_EMBEDDING_BASE_URLS: Record<string, string> = {
	google: "https://generativelanguage.googleapis.com/v1beta",
};

const DEFAULT_MEMORY_EMBEDDING_API_KEY_ENVS: Record<string, string> = {
	google: "GEMINI_API_KEY",
};

export interface TtsVoiceSettings {
	stability: number;
	similarityBoost: number;
	style: number;
	speed: number;
	useSpeakerBoost: boolean;
}

export interface Config {
	workspacePath: string;
	discord: {
		token: string;
		ownerId: string;
		allowedChannels: string[];
		replyMode: DiscordReplyMode;
		chunkMode: DiscordChunkMode;
		dmMode: DiscordDispatchMode;
		channelMode: DiscordDispatchMode;
		channelTrigger: DiscordChannelTrigger;
		collectDebounceMs: number;
		allowBotMessages: boolean;
	};
	web: {
		port: number;
		authMode: WebAuthMode;
		bearerToken?: string;
		totpSecret?: string;
		bindAddress: string;
	};
	agent: {
		model: string;
		api?: string;
		modelId?: string;
		baseUrl?: string;
		apiKeyEnv?: string;
		provider?: string;
		cacheRetention: CacheRetention;
		thinkingLevel: ThinkingLevel;
	};
	heartbeat: {
		enabled: boolean;
		idleThresholdMs: number;
		intervalMs: number;
	};
	cron: {
		enabled: boolean;
		pollMs: number;
		jobs: Array<{
			id: string;
			enabled: boolean;
			frequency: CronFrequency;
			deliveryMode: CronDeliveryMode;
			prompt: string;
			runAt?: string;
			time?: string;
			minute?: number;
			weekday?: number;
			day?: number;
		}>;
	};
	models: {
		allow: string[];
		baseUrls: Record<string, string>;
		apiKeyEnvs: Record<string, string>;
	};
	tts: {
		provider: TtsProvider;
		apiKeyEnv: string;
		voiceId: string;
		modelId: string;
		outputFormat: string;
		maxInputChars: number;
		voiceSettings: TtsVoiceSettings;
	};
	mediaUnderstanding: {
		audio: {
			provider: MediaUnderstandingProvider;
			model: string;
			apiKeyEnv: string;
		};
		video: {
			provider: MediaUnderstandingProvider;
			model: string;
			apiKeyEnv: string;
		};
	};
	persona: {
		soul: string;
		user: string;
		memory: string;
		inner: string;
	};
	media: {
		generatedRetentionDays: number;
	};
	data: {
		chat: {
			retentionDays: number;
		};
		transcripts: {
			retentionDays: number;
		};
		payloads: {
			retentionDays: number;
		};
	};
	workspace: {
		dataDir: string;
	};
	memory: {
		rootDir: string;
		indexDir: string;
		lcmDir: string;
		diariesDir: string;
		archiveDir: string;
		embedding: {
			format?: MemoryEmbeddingFormat;
			api: MemoryEmbeddingFormat;
			provider: string;
			model: string;
			baseUrl: string;
			apiKeyEnv: string;
			dimensions: number;
			batchSize: number;
		};
		ambient: {
			enabled: boolean;
			topK: number;
			minQueryLength: number;
			throttleSeconds: number;
			weightSimilarity: number;
			weightValence: number;
			weightRecency: number;
			weightIntensity: number;
		};
		lcm: {
			enabled: boolean;
			model: string;
			provider: string;
			modelId: string;
			baseUrl?: string;
			apiKeyEnv?: string;
			contextThreshold: number;
			freshTailCount: number;
			freshTailMaxTokens?: number;
			leafChunkTokens: number;
			leafTargetTokens: number;
			promptAwareEvictionEnabled: boolean;
			condenseGroupSize: number;
			maxSummaryDepth: number;
			newSessionRetainDepth: number;
			maxRounds: number;
			cacheTtlMs: number;
			cacheTouchSlackMs: number;
			criticalOverflowTokens: number;
			timeoutMs: number;
			prompt?: string;
			promptPath?: string;
			systemPrompt?: string;
			systemPromptPath?: string;
		};
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

function readOptionalConfigString(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`Config value ${path} must be a string`);
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function readConfigString(value: unknown, fallback: string, path: string): string {
	const read = readOptionalConfigString(value, path);
	return read ?? fallback;
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

function warnOnce(key: string, message: string): void {
	if (loggedConfigWarnings.has(key)) return;
	loggedConfigWarnings.add(key);
	console.warn(message);
}

function readCacheRetention(value: unknown, path = "agent.cache_retention"): CacheRetention {
	if (value === "none" || value === "short" || value === "long") return value;
	throw new Error(`Config value ${path} must be one of "none", "short", or "long"`);
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

function readDiscordReplyMode(value: unknown): DiscordReplyMode {
	if (value === "plain" || value === "reply") return value;
	throw new Error('Config value discord.reply_mode must be one of "plain" or "reply"');
}

function readDiscordChunkMode(value: unknown): DiscordChunkMode {
	if (value === "simple" || value === "paragraph" || value === "newline") return value;
	throw new Error('Config value discord.chunk_mode must be one of "simple", "paragraph", or "newline"');
}

function readDiscordDispatchMode(value: unknown, path: string): DiscordDispatchMode {
	if (value === "steer" || value === "queue" || value === "collect") return value;
	throw new Error(`Config value ${path} must be one of "steer", "queue", or "collect"`);
}

function readDiscordChannelTrigger(value: unknown): DiscordChannelTrigger {
	if (value === "mention" || value === "always") return value;
	throw new Error('Config value discord.channel_trigger must be one of "mention" or "always"');
}

function readCronFrequency(value: unknown, path: string): CronFrequency {
	if (value === "once" || value === "hourly" || value === "daily" || value === "weekly" || value === "monthly") {
		return value;
	}
	throw new Error(`Config value ${path} must be one of "once", "hourly", "daily", "weekly", or "monthly"`);
}

function readCronDeliveryMode(value: unknown, path: string): CronDeliveryMode {
	if (value === "queue" || value === "follow_up") return value;
	throw new Error(`Config value ${path} must be one of "queue" or "follow_up"`);
}

function readWebAuthMode(value: unknown): WebAuthMode {
	if (value === "tailscale-only" || value === "bearer" || value === "public-2fa") return value;
	throw new Error('Config value web.auth_mode must be one of "tailscale-only", "bearer", or "public-2fa"');
}

function readTtsProvider(value: unknown): TtsProvider {
	if (value === "elevenlabs") return value;
	throw new Error('Config value tts.provider must be "elevenlabs"');
}

function readMediaUnderstandingProvider(value: unknown): MediaUnderstandingProvider {
	if (value === "groq" || value === "google") return value;
	throw new Error('Config value media_understanding provider must be "groq" or "google"');
}

function readMemoryEmbeddingFormat(value: unknown, path = "memory.embedding.format"): MemoryEmbeddingFormat {
	if (value === "gemini" || value === "openai" || value === "voyage") return value;
	throw new Error(`Config value ${path} must be one of "gemini", "openai", or "voyage"`);
}

function readBoolean(value: unknown, fallback: boolean, path: string): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	throw new Error(`Config value ${path} must be a boolean`);
}

function readInteger(value: unknown, fallback: number, path: string, min = 0): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
		throw new Error(`Config value ${path} must be an integer >= ${min}`);
	}
	return value;
}

function resolveProviderSetting(records: Record<string, string>, provider: string, model: string): string | undefined {
	return records[`${provider}/${model}`] ?? records[provider];
}

function readNumberInRange(value: unknown, fallback: number, path: string, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
		throw new Error(`Config value ${path} must be a number between ${min} and ${max}`);
	}
	return value;
}

function readFraction(value: unknown, fallback: number, path: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
		throw new Error(`Config value ${path} must be a number > 0 and <= 1`);
	}
	return value;
}

function readPositiveNumber(value: unknown, fallback: number, path: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Config value ${path} must be a positive number`);
	}
	return value;
}

function readOptionalInteger(value: unknown, path: string, min = 0): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
		throw new Error(`Config value ${path} must be an integer >= ${min}`);
	}
	return value;
}

function readIntegerInRange(value: unknown, fallback: number, path: string, min: number, max: number): number {
	const read = readInteger(value, fallback, path, min);
	if (read > max) throw new Error(`Config value ${path} must be an integer <= ${max}`);
	return read;
}

function readOptionalIntegerInRange(value: unknown, path: string, min: number, max: number): number | undefined {
	const read = readOptionalInteger(value, path, min);
	if (read !== undefined && read > max) throw new Error(`Config value ${path} must be an integer <= ${max}`);
	return read;
}

function assertCronTime(value: string | undefined, path: string): void {
	if (value === undefined) return;
	if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(value)) {
		throw new Error(`Config value ${path} must be HH:MM local time`);
	}
}

function assertCronRunAt(value: string | undefined, path: string): void {
	if (value === undefined) return;
	if (Number.isFinite(Date.parse(value))) return;
	if (/^\d{4}-\d{2}-\d{2}[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.test(value)) return;
	throw new Error(`Config value ${path} must be an ISO timestamp or YYYY-MM-DD HH:MM local time`);
}

function resolveWorkspacePath(workspacePath: string, filePath: string): string {
	return isAbsolute(filePath) ? filePath : resolve(workspacePath, filePath);
}

function parseProviderModelRef(value: string, path: string): { provider: string; modelId: string; key: string } {
	const parsed = maybeParseProviderModelRef(value);
	if (parsed) return parsed;
	throw new Error(`Config value ${path} must be a provider/model id`);
}

function maybeParseProviderModelRef(value: string): { provider: string; modelId: string; key: string } | undefined {
	const trimmed = value.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, separator).trim();
	const modelId = trimmed.slice(separator + 1).trim();
	if (!provider || !modelId) return undefined;
	return { provider, modelId, key: `${provider}/${modelId}` };
}

function assertKnownKeys(value: Record<string, unknown>, path: string, knownKeys: readonly string[]): void {
	const known = new Set(knownKeys);
	for (const key of Object.keys(value)) {
		if (!known.has(key)) throw new Error(`Unknown config value: ${path}.${key}`);
	}
}

function readPromptOverrides(
	value: Record<string, unknown>,
	workspacePath: string,
	prefix: string,
): { prompt?: string; promptPath?: string; systemPrompt?: string; systemPromptPath?: string } {
	const prompt = readOptionalConfigString(value.prompt, `${prefix}.prompt`);
	const promptPath = readOptionalConfigString(value.prompt_path, `${prefix}.prompt_path`);
	const systemPrompt = readOptionalConfigString(value.system_prompt, `${prefix}.system_prompt`);
	const systemPromptPath = readOptionalConfigString(value.system_prompt_path, `${prefix}.system_prompt_path`);
	if (prompt && promptPath) throw new Error(`Set either ${prefix}.prompt or ${prefix}.prompt_path, not both`);
	if (systemPrompt && systemPromptPath) {
		throw new Error(`Set either ${prefix}.system_prompt or ${prefix}.system_prompt_path, not both`);
	}
	return {
		...(prompt ? { prompt } : {}),
		...(promptPath ? { promptPath: resolveWorkspacePath(workspacePath, promptPath) } : {}),
		...(systemPrompt ? { systemPrompt } : {}),
		...(systemPromptPath ? { systemPromptPath: resolveWorkspacePath(workspacePath, systemPromptPath) } : {}),
	};
}

function readCronJobs(cron: Record<string, unknown>): Config["cron"]["jobs"] {
	const rawJobs = cron.jobs;
	if (rawJobs === undefined) return [];
	if (!Array.isArray(rawJobs)) throw new Error("Config value cron.jobs must be an array");
	const seen = new Set<string>();
	return rawJobs.map((rawJob, index) => {
		if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob)) {
			throw new Error(`Config value cron.jobs[${index}] must be a table`);
		}
		const job = rawJob as Record<string, unknown>;
		const prefix = `cron.jobs[${index}]`;
		assertKnownKeys(job, prefix, [
			"id",
			"enabled",
			"frequency",
			"delivery_mode",
			"prompt",
			"run_at",
			"time",
			"minute",
			"weekday",
			"day",
		]);
		const id = readString(job.id, `${prefix}.id`);
		if (!/^[A-Za-z0-9._=-]+$/.test(id)) {
			throw new Error(
				`Config value ${prefix}.id may only contain letters, numbers, dot, underscore, equals, or dash`,
			);
		}
		if (seen.has(id)) throw new Error(`Duplicate cron job id: ${id}`);
		seen.add(id);
		const frequency = readCronFrequency(
			readConfigString(job.frequency, "once", `${prefix}.frequency`),
			`${prefix}.frequency`,
		);
		const runAt = readOptionalConfigString(job.run_at, `${prefix}.run_at`);
		const time = readOptionalConfigString(job.time, `${prefix}.time`);
		assertCronRunAt(runAt, `${prefix}.run_at`);
		assertCronTime(time, `${prefix}.time`);
		if (frequency === "once" && !runAt) throw new Error(`Config value ${prefix}.run_at is required for once jobs`);
		if (frequency === "once" && time) throw new Error(`Config value ${prefix}.time is only valid for repeating jobs`);
		if (frequency !== "once" && runAt) throw new Error(`Config value ${prefix}.run_at is only valid for once jobs`);
		if (frequency !== "once" && frequency !== "hourly" && !time) {
			throw new Error(`Config value ${prefix}.time is required for ${frequency} jobs`);
		}
		return {
			id,
			enabled: readBoolean(job.enabled, true, `${prefix}.enabled`),
			frequency,
			deliveryMode: readCronDeliveryMode(
				readConfigString(job.delivery_mode, "queue", `${prefix}.delivery_mode`),
				`${prefix}.delivery_mode`,
			),
			prompt: readString(job.prompt, `${prefix}.prompt`),
			...(runAt ? { runAt } : {}),
			...(time ? { time } : {}),
			...(job.minute !== undefined
				? { minute: readOptionalIntegerInRange(job.minute, `${prefix}.minute`, 0, 59) }
				: {}),
			...(job.weekday !== undefined
				? { weekday: readOptionalIntegerInRange(job.weekday, `${prefix}.weekday`, 0, 6) }
				: {}),
			...(job.day !== undefined ? { day: readOptionalIntegerInRange(job.day, `${prefix}.day`, 1, 31) } : {}),
		};
	});
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
	const web = (parsed.web ?? {}) as Record<string, unknown>;
	const agent = (parsed.agent ?? {}) as Record<string, unknown>;
	const heartbeat = (parsed.heartbeat ?? {}) as Record<string, unknown>;
	const cron = (parsed.cron ?? {}) as Record<string, unknown>;
	const models = (parsed.models ?? {}) as Record<string, unknown>;
	const tts = (parsed.tts ?? {}) as Record<string, unknown>;
	const ttsVoiceSettings = (tts.voice_settings ?? {}) as Record<string, unknown>;
	const media = (parsed.media ?? {}) as Record<string, unknown>;
	const generatedMedia = (media.generated ?? {}) as Record<string, unknown>;
	const data = (parsed.data ?? {}) as Record<string, unknown>;
	const dataChat = (data.chat ?? {}) as Record<string, unknown>;
	const dataTranscripts = (data.transcripts ?? {}) as Record<string, unknown>;
	const dataPayloads = (data.payloads ?? {}) as Record<string, unknown>;
	const mediaUnderstanding = (media.understanding ?? {}) as Record<string, unknown>;
	const mediaUnderstandingAudio = (mediaUnderstanding.audio ?? {}) as Record<string, unknown>;
	const mediaUnderstandingVideo = (mediaUnderstanding.video ?? {}) as Record<string, unknown>;
	const persona = (parsed.persona ?? {}) as Record<string, unknown>;
	const workspace = (parsed.workspace ?? {}) as Record<string, unknown>;
	const memory = (parsed.memory ?? {}) as Record<string, unknown>;
	const memoryEmbedding = (memory.embedding ?? {}) as Record<string, unknown>;
	const memoryAmbient = (memory.ambient ?? {}) as Record<string, unknown>;
	const memoryLcm = (memory.lcm ?? {}) as Record<string, unknown>;

	const ownerId = readString(discord.owner_id, "discord.owner_id");
	const model = readOptionalString(agent.model, "");
	const provider = readOptionalString(agent.provider, "custom");
	const modelId = readOptionalString(agent.model_id, "");
	const api = readOptionalString(agent.api, "");
	const baseUrl = readOptionalString(agent.base_url, "");
	const apiKeyEnv = readOptionalString(agent.api_key_env, "");
	const legacyModel = modelId ? `${provider}/${modelId}` : "";
	const agentModel = model || legacyModel;
	const usingLegacyAgentModel = !model;
	let agentCacheRetentionRaw: unknown = agent.cache_retention;
	if (agentCacheRetentionRaw === undefined && agent.cacheRetention !== undefined) {
		warnOnce(
			"agent.cacheRetention",
			"Config value agent.cacheRetention is deprecated; use agent.cache_retention instead.",
		);
		agentCacheRetentionRaw = agent.cacheRetention;
	}
	if (usingLegacyAgentModel && (!api || !modelId || !baseUrl || !apiKeyEnv)) {
		throw new Error(
			'Set agent.model = "provider/model", or for a legacy custom endpoint set all of agent.api, agent.model_id, agent.base_url, and agent.api_key_env.',
		);
	}

	const memoryRootDir = resolveWorkspacePath(workspacePath, readOptionalString(memory.root_dir, "memories"));
	const modelAllow = readStringArray(models.allow, "models.allow");
	const modelBaseUrls = readStringRecord(models.base_urls, "models.base_urls");
	const modelApiKeyEnvs = readStringRecord(models.api_key_envs, "models.api_key_envs");
	let memoryEmbeddingFormatRaw: unknown = memoryEmbedding.format;
	if (memoryEmbeddingFormatRaw === undefined && memoryEmbedding.api !== undefined) {
		warnOnce(
			"memory.embedding.api",
			"Config value memory.embedding.api is deprecated; use memory.embedding.format instead.",
		);
		memoryEmbeddingFormatRaw = memoryEmbedding.api;
	}
	const memoryEmbeddingFormat = readMemoryEmbeddingFormat(
		readOptionalString(memoryEmbeddingFormatRaw, "gemini"),
		memoryEmbedding.format === undefined && memoryEmbedding.api !== undefined
			? "memory.embedding.api"
			: "memory.embedding.format",
	);
	const memoryEmbeddingProvider = readConfigString(memoryEmbedding.provider, "google", "memory.embedding.provider");
	const memoryEmbeddingModel = readConfigString(memoryEmbedding.model, "gemini-embedding-2", "memory.embedding.model");
	const memoryEmbeddingBaseUrl =
		readOptionalConfigString(memoryEmbedding.base_url, "memory.embedding.base_url") ??
		resolveProviderSetting(modelBaseUrls, memoryEmbeddingProvider, memoryEmbeddingModel) ??
		DEFAULT_MEMORY_EMBEDDING_BASE_URLS[memoryEmbeddingProvider] ??
		"";
	const memoryEmbeddingApiKeyEnv =
		readOptionalConfigString(memoryEmbedding.api_key_env, "memory.embedding.api_key_env") ??
		resolveProviderSetting(modelApiKeyEnvs, memoryEmbeddingProvider, memoryEmbeddingModel) ??
		DEFAULT_MEMORY_EMBEDDING_API_KEY_ENVS[memoryEmbeddingProvider] ??
		"";
	if (!memoryEmbeddingBaseUrl) {
		throw new Error(`Missing memory.embedding.base_url for provider: ${memoryEmbeddingProvider}`);
	}
	// Empty apiKeyEnv is allowed for no-auth local gateways. Hosted providers
	// should either inherit from models.api_key_envs or set memory.embedding.api_key_env.
	assertKnownKeys(memoryLcm, "memory.lcm", [
		"enabled",
		"model",
		"context_threshold",
		"fresh_tail_count",
		"fresh_tail_max_tokens",
		"leaf_chunk_tokens",
		"leaf_target_tokens",
		"prompt_aware_eviction_enabled",
		"condense_group_size",
		"max_summary_depth",
		"new_session_retain_depth",
		"max_rounds",
		"cache_ttl_ms",
		"cache_touch_slack_ms",
		"critical_overflow_tokens",
		"timeout_ms",
		"prompt",
		"prompt_path",
		"system_prompt",
		"system_prompt_path",
	]);
	const memoryLcmEnabled = readBoolean(memoryLcm.enabled, true, "memory.lcm.enabled");
	let memoryLcmRef: { provider: string; modelId: string; key: string };
	let memoryLcmBaseUrl: string | undefined;
	let memoryLcmApiKeyEnv: string | undefined;
	let memoryLcmFreshTailMaxTokens: number | undefined;
	let memoryLcmLeafChunkTokens = 20_000;
	let memoryLcmLeafTargetTokens = 2400;
	let memoryLcmPromptOverrides: ReturnType<typeof readPromptOverrides> = {};
	if (memoryLcmEnabled) {
		const memoryLcmModel = readConfigString(memoryLcm.model, agentModel, "memory.lcm.model");
		memoryLcmRef = parseProviderModelRef(memoryLcmModel, "memory.lcm.model");
		if (modelAllow.length > 0 && !modelAllow.includes(memoryLcmRef.key)) {
			throw new Error(`Config value memory.lcm.model is not in models.allow: ${memoryLcmRef.key}`);
		}
		memoryLcmBaseUrl =
			resolveProviderSetting(modelBaseUrls, memoryLcmRef.provider, memoryLcmRef.modelId) ??
			(usingLegacyAgentModel && memoryLcmRef.key === legacyModel ? baseUrl : undefined);
		memoryLcmApiKeyEnv =
			resolveProviderSetting(modelApiKeyEnvs, memoryLcmRef.provider, memoryLcmRef.modelId) ??
			(usingLegacyAgentModel && memoryLcmRef.provider === provider ? apiKeyEnv : undefined);
		memoryLcmFreshTailMaxTokens = readOptionalInteger(
			memoryLcm.fresh_tail_max_tokens,
			"memory.lcm.fresh_tail_max_tokens",
			1,
		);
		memoryLcmLeafChunkTokens = readInteger(memoryLcm.leaf_chunk_tokens, 20_000, "memory.lcm.leaf_chunk_tokens", 1);
		memoryLcmLeafTargetTokens = readInteger(memoryLcm.leaf_target_tokens, 2400, "memory.lcm.leaf_target_tokens", 1);
		if (memoryLcmLeafTargetTokens > memoryLcmLeafChunkTokens) {
			throw new Error("Config value memory.lcm.leaf_target_tokens must be <= leaf_chunk_tokens");
		}
		if (memoryLcmFreshTailMaxTokens !== undefined && memoryLcmFreshTailMaxTokens > memoryLcmLeafChunkTokens) {
			throw new Error("Config value memory.lcm.fresh_tail_max_tokens must be <= leaf_chunk_tokens");
		}
		memoryLcmPromptOverrides = readPromptOverrides(memoryLcm, workspacePath, "memory.lcm");
	} else {
		// Disabled LCM configs may keep stale summarizer-only fields; runtime checks enabled before using them.
		const rawModel = typeof memoryLcm.model === "string" && memoryLcm.model.trim() ? memoryLcm.model : agentModel;
		memoryLcmRef = maybeParseProviderModelRef(rawModel) ?? { provider: "", modelId: "", key: rawModel };
	}

	return {
		workspacePath,
		discord: {
			token: readString(process.env.DISCORD_TOKEN, "DISCORD_TOKEN"),
			ownerId,
			allowedChannels: readStringArray(discord.allowed_channels, "discord.allowed_channels"),
			replyMode: readDiscordReplyMode(readOptionalString(discord.reply_mode, "plain")),
			chunkMode: readDiscordChunkMode(readOptionalString(discord.chunk_mode, "paragraph")),
			dmMode: readDiscordDispatchMode(readOptionalString(discord.dm_mode, "steer"), "discord.dm_mode"),
			channelMode: readDiscordDispatchMode(
				readOptionalString(discord.channel_mode, "collect"),
				"discord.channel_mode",
			),
			channelTrigger: readDiscordChannelTrigger(readOptionalString(discord.channel_trigger, "mention")),
			collectDebounceMs: readInteger(discord.collect_debounce_ms, 4000, "discord.collect_debounce_ms"),
			allowBotMessages: readBoolean(discord.allow_bot_messages, false, "discord.allow_bot_messages"),
		},
		web: {
			port: readInteger(web.port, 8787, "web.port"),
			authMode: readWebAuthMode(readOptionalString(web.auth_mode, "tailscale-only")),
			bearerToken: readOptionalString(web.bearer_token, "") || undefined,
			totpSecret: readOptionalString(web.totp_secret, "") || undefined,
			bindAddress: readOptionalString(web.bind_address, "127.0.0.1"),
		},
		agent: {
			model: agentModel,
			api: usingLegacyAgentModel ? api : undefined,
			modelId: usingLegacyAgentModel ? modelId : undefined,
			baseUrl: usingLegacyAgentModel ? baseUrl : undefined,
			apiKeyEnv: usingLegacyAgentModel ? apiKeyEnv : undefined,
			provider: usingLegacyAgentModel ? provider : undefined,
			cacheRetention: readCacheRetention(
				readOptionalString(agentCacheRetentionRaw, "long"),
				agent.cache_retention === undefined && agent.cacheRetention !== undefined
					? "agent.cacheRetention"
					: "agent.cache_retention",
			),
			thinkingLevel: readThinkingLevel(readOptionalString(agent.thinking_level, "medium")),
		},
		heartbeat: {
			enabled: readBoolean(heartbeat.enabled, false, "heartbeat.enabled"),
			idleThresholdMs:
				readInteger(heartbeat.idle_threshold_minutes, 60, "heartbeat.idle_threshold_minutes", 1) * 60_000,
			intervalMs: readInteger(heartbeat.interval_minutes, 240, "heartbeat.interval_minutes", 1) * 60_000,
		},
		cron: {
			enabled: readBoolean(cron.enabled, false, "cron.enabled"),
			pollMs: readIntegerInRange(cron.poll_seconds, 60, "cron.poll_seconds", 1, 3600) * 1000,
			jobs: readCronJobs(cron),
		},
		models: {
			allow: modelAllow,
			baseUrls: modelBaseUrls,
			apiKeyEnvs: modelApiKeyEnvs,
		},
		tts: {
			provider: readTtsProvider(readOptionalString(tts.provider, "elevenlabs")),
			apiKeyEnv: readOptionalString(tts.api_key_env, "ELEVENLABS_API_KEY"),
			voiceId: readOptionalString(tts.voice_id, ""),
			modelId: readOptionalString(tts.model_id, "eleven_multilingual_v2"),
			outputFormat: readOptionalString(tts.output_format, "mp3_44100_128"),
			maxInputChars: readInteger(tts.max_input_chars, 5000, "tts.max_input_chars"),
			voiceSettings: {
				stability: readNumberInRange(ttsVoiceSettings.stability, 0.5, "tts.voice_settings.stability", 0, 1),
				similarityBoost: readNumberInRange(
					ttsVoiceSettings.similarity_boost,
					0.75,
					"tts.voice_settings.similarity_boost",
					0,
					1,
				),
				style: readNumberInRange(ttsVoiceSettings.style, 0, "tts.voice_settings.style", 0, 1),
				speed: readPositiveNumber(ttsVoiceSettings.speed, 1, "tts.voice_settings.speed"),
				useSpeakerBoost: readBoolean(
					ttsVoiceSettings.use_speaker_boost,
					true,
					"tts.voice_settings.use_speaker_boost",
				),
			},
		},
		mediaUnderstanding: {
			audio: {
				provider: readMediaUnderstandingProvider(readOptionalString(mediaUnderstandingAudio.provider, "groq")),
				model: readOptionalString(mediaUnderstandingAudio.model, "whisper-large-v3"),
				apiKeyEnv: readOptionalString(mediaUnderstandingAudio.api_key_env, "GROQ_API_KEY"),
			},
			video: {
				provider: readMediaUnderstandingProvider(readOptionalString(mediaUnderstandingVideo.provider, "google")),
				model: readOptionalString(mediaUnderstandingVideo.model, "gemini-3-flash-preview"),
				apiKeyEnv: readOptionalString(mediaUnderstandingVideo.api_key_env, "GEMINI_API_KEY"),
			},
		},
		persona: {
			soul: resolveWorkspacePath(workspacePath, readOptionalString(persona.soul, "SOUL.md")),
			user: resolveWorkspacePath(workspacePath, readOptionalString(persona.user, "USER.md")),
			memory: resolveWorkspacePath(workspacePath, readOptionalString(persona.memory, "MEMORY.md")),
			inner: resolveWorkspacePath(workspacePath, readOptionalString(persona.inner, "INNER.md")),
		},
		media: {
			generatedRetentionDays: readInteger(generatedMedia.retention_days, 30, "media.generated.retention_days"),
		},
		data: {
			chat: {
				retentionDays: readInteger(dataChat.retention_days, 0, "data.chat.retention_days"),
			},
			transcripts: {
				retentionDays: readInteger(dataTranscripts.retention_days, 0, "data.transcripts.retention_days"),
			},
			payloads: {
				retentionDays: readInteger(dataPayloads.retention_days, 7, "data.payloads.retention_days"),
			},
		},
		workspace: {
			dataDir: resolveWorkspacePath(workspacePath, readOptionalString(workspace.data_dir, "data")),
		},
		memory: {
			rootDir: memoryRootDir,
			indexDir: resolve(memoryRootDir, "index"),
			lcmDir: resolve(memoryRootDir, "lcm"),
			diariesDir: resolve(memoryRootDir, "diaries"),
			archiveDir: resolve(memoryRootDir, "archive"),
			embedding: {
				format: memoryEmbeddingFormat,
				api: memoryEmbeddingFormat,
				provider: memoryEmbeddingProvider,
				model: memoryEmbeddingModel,
				baseUrl: memoryEmbeddingBaseUrl,
				apiKeyEnv: memoryEmbeddingApiKeyEnv,
				dimensions: readInteger(memoryEmbedding.dimensions, 3072, "memory.embedding.dimensions", 1),
				batchSize: readInteger(memoryEmbedding.batch_size, 32, "memory.embedding.batch_size", 1),
			},
			ambient: {
				enabled: readBoolean(memoryAmbient.enabled, true, "memory.ambient.enabled"),
				topK: readInteger(memoryAmbient.top_k, 3, "memory.ambient.top_k", 1),
				minQueryLength: readInteger(memoryAmbient.min_query_length, 8, "memory.ambient.min_query_length"),
				throttleSeconds: readInteger(memoryAmbient.throttle_seconds, 30, "memory.ambient.throttle_seconds"),
				weightSimilarity: readPositiveNumber(
					memoryAmbient.weight_similarity,
					1.0,
					"memory.ambient.weight_similarity",
				),
				weightValence: readNumberInRange(
					memoryAmbient.weight_valence,
					0.08,
					"memory.ambient.weight_valence",
					0,
					10,
				),
				weightRecency: readNumberInRange(
					memoryAmbient.weight_recency,
					0.08,
					"memory.ambient.weight_recency",
					0,
					10,
				),
				weightIntensity: readNumberInRange(
					memoryAmbient.weight_intensity,
					0.1,
					"memory.ambient.weight_intensity",
					0,
					10,
				),
			},
			lcm: {
				enabled: memoryLcmEnabled,
				model: memoryLcmRef.key,
				provider: memoryLcmRef.provider,
				modelId: memoryLcmRef.modelId,
				...(memoryLcmBaseUrl !== undefined ? { baseUrl: memoryLcmBaseUrl } : {}),
				...(memoryLcmApiKeyEnv !== undefined ? { apiKeyEnv: memoryLcmApiKeyEnv } : {}),
				contextThreshold: memoryLcmEnabled
					? readFraction(memoryLcm.context_threshold, 0.75, "memory.lcm.context_threshold")
					: 0.75,
				freshTailCount: memoryLcmEnabled
					? readInteger(memoryLcm.fresh_tail_count, 64, "memory.lcm.fresh_tail_count")
					: 64,
				...(memoryLcmFreshTailMaxTokens !== undefined ? { freshTailMaxTokens: memoryLcmFreshTailMaxTokens } : {}),
				leafChunkTokens: memoryLcmLeafChunkTokens,
				leafTargetTokens: memoryLcmLeafTargetTokens,
				promptAwareEvictionEnabled: memoryLcmEnabled
					? readBoolean(memoryLcm.prompt_aware_eviction_enabled, true, "memory.lcm.prompt_aware_eviction_enabled")
					: true,
				condenseGroupSize: memoryLcmEnabled
					? readInteger(memoryLcm.condense_group_size, 4, "memory.lcm.condense_group_size", 1)
					: 4,
				maxSummaryDepth: memoryLcmEnabled
					? readInteger(memoryLcm.max_summary_depth, 2, "memory.lcm.max_summary_depth", 1)
					: 2,
				newSessionRetainDepth: memoryLcmEnabled
					? readInteger(memoryLcm.new_session_retain_depth, 2, "memory.lcm.new_session_retain_depth", -1)
					: 2,
				maxRounds: memoryLcmEnabled ? readInteger(memoryLcm.max_rounds, 10, "memory.lcm.max_rounds", 1) : 10,
				cacheTtlMs: memoryLcmEnabled
					? readInteger(memoryLcm.cache_ttl_ms, 300_000, "memory.lcm.cache_ttl_ms", 1)
					: 300_000,
				cacheTouchSlackMs: memoryLcmEnabled
					? readInteger(memoryLcm.cache_touch_slack_ms, 30_000, "memory.lcm.cache_touch_slack_ms", 0)
					: 30_000,
				criticalOverflowTokens: memoryLcmEnabled
					? readInteger(memoryLcm.critical_overflow_tokens, 8000, "memory.lcm.critical_overflow_tokens", 1)
					: 8000,
				timeoutMs: memoryLcmEnabled
					? readInteger(memoryLcm.timeout_ms, 60_000, "memory.lcm.timeout_ms", 1)
					: 60_000,
				...memoryLcmPromptOverrides,
			},
		},
	};
}
