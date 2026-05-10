import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { parse } from "smol-toml";

export type CacheRetention = "none" | "short" | "long";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type DiscordReplyMode = "plain" | "reply";
export type DiscordChunkMode = "simple" | "paragraph";
export type DiscordDispatchMode = "steer" | "queue" | "collect";
export type DiscordChannelTrigger = "mention" | "always";
export type WebAuthMode = "tailscale-only" | "bearer" | "public-2fa";
export type TtsProvider = "elevenlabs";
export type MediaUnderstandingProvider = "groq" | "google";
export type MemoryEmbeddingApi = "gemini";

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
	};
	media: {
		generatedRetentionDays: number;
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
			api: MemoryEmbeddingApi;
			provider: string;
			model: string;
			baseUrl: string;
			apiKeyEnv: string;
			dimensions: number;
			batchSize: number;
		};
		lcm: {
			newSessionRetainDepth: number;
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

function readDiscordReplyMode(value: unknown): DiscordReplyMode {
	if (value === "plain" || value === "reply") return value;
	throw new Error('Config value discord.reply_mode must be one of "plain" or "reply"');
}

function readDiscordChunkMode(value: unknown): DiscordChunkMode {
	if (value === "simple" || value === "paragraph") return value;
	throw new Error('Config value discord.chunk_mode must be one of "simple" or "paragraph"');
}

function readDiscordDispatchMode(value: unknown, path: string): DiscordDispatchMode {
	if (value === "steer" || value === "queue" || value === "collect") return value;
	throw new Error(`Config value ${path} must be one of "steer", "queue", or "collect"`);
}

function readDiscordChannelTrigger(value: unknown): DiscordChannelTrigger {
	if (value === "mention" || value === "always") return value;
	throw new Error('Config value discord.channel_trigger must be one of "mention" or "always"');
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

function readMemoryEmbeddingApi(value: unknown): MemoryEmbeddingApi {
	if (value === "gemini") return value;
	throw new Error('Config value memory.embedding.api must be "gemini"');
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

function readPositiveNumber(value: unknown, fallback: number, path: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Config value ${path} must be a positive number`);
	}
	return value;
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
	const web = (parsed.web ?? {}) as Record<string, unknown>;
	const agent = (parsed.agent ?? {}) as Record<string, unknown>;
	const models = (parsed.models ?? {}) as Record<string, unknown>;
	const tts = (parsed.tts ?? {}) as Record<string, unknown>;
	const ttsVoiceSettings = (tts.voice_settings ?? {}) as Record<string, unknown>;
	const media = (parsed.media ?? {}) as Record<string, unknown>;
	const generatedMedia = (media.generated ?? {}) as Record<string, unknown>;
	const mediaUnderstanding = (media.understanding ?? {}) as Record<string, unknown>;
	const mediaUnderstandingAudio = (mediaUnderstanding.audio ?? {}) as Record<string, unknown>;
	const mediaUnderstandingVideo = (mediaUnderstanding.video ?? {}) as Record<string, unknown>;
	const persona = (parsed.persona ?? {}) as Record<string, unknown>;
	const workspace = (parsed.workspace ?? {}) as Record<string, unknown>;
	const memory = (parsed.memory ?? {}) as Record<string, unknown>;
	const memoryEmbedding = (memory.embedding ?? {}) as Record<string, unknown>;
	const memoryLcm = (memory.lcm ?? {}) as Record<string, unknown>;

	const ownerId = readString(discord.owner_id, "discord.owner_id");
	const model = readOptionalString(agent.model, "");
	const provider = readOptionalString(agent.provider, "custom");
	const modelId = readOptionalString(agent.model_id, "");
	const api = readOptionalString(agent.api, "");
	const baseUrl = readOptionalString(agent.base_url, "");
	const apiKeyEnv = readOptionalString(agent.api_key_env, "");
	const legacyModel = modelId ? `${provider}/${modelId}` : "";
	const usingLegacyAgentModel = !model;
	if (usingLegacyAgentModel && (!api || !modelId || !baseUrl || !apiKeyEnv)) {
		throw new Error(
			'Set agent.model = "provider/model", or for a legacy custom endpoint set all of agent.api, agent.model_id, agent.base_url, and agent.api_key_env.',
		);
	}

	const memoryRootDir = resolveWorkspacePath(workspacePath, readOptionalString(memory.root_dir, "memories"));
	const modelBaseUrls = readStringRecord(models.base_urls, "models.base_urls");
	const modelApiKeyEnvs = readStringRecord(models.api_key_envs, "models.api_key_envs");
	const memoryEmbeddingApi = readMemoryEmbeddingApi(readOptionalString(memoryEmbedding.api, "gemini"));
	const memoryEmbeddingProvider = readConfigString(memoryEmbedding.provider, "google", "memory.embedding.provider");
	const memoryEmbeddingModel = readConfigString(
		memoryEmbedding.model,
		"gemini-embedding-2",
		"memory.embedding.model",
	);
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
			model: model || legacyModel,
			api: usingLegacyAgentModel ? api : undefined,
			modelId: usingLegacyAgentModel ? modelId : undefined,
			baseUrl: usingLegacyAgentModel ? baseUrl : undefined,
			apiKeyEnv: usingLegacyAgentModel ? apiKeyEnv : undefined,
			provider: usingLegacyAgentModel ? provider : undefined,
			cacheRetention: readCacheRetention(readOptionalString(agent.cacheRetention, "long")),
			thinkingLevel: readThinkingLevel(readOptionalString(agent.thinking_level, "medium")),
		},
		models: {
			allow: readStringArray(models.allow, "models.allow"),
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
		},
		media: {
			generatedRetentionDays: readInteger(generatedMedia.retention_days, 30, "media.generated.retention_days"),
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
				api: memoryEmbeddingApi,
				provider: memoryEmbeddingProvider,
				model: memoryEmbeddingModel,
				baseUrl: memoryEmbeddingBaseUrl,
				apiKeyEnv: memoryEmbeddingApiKeyEnv,
				dimensions: readInteger(memoryEmbedding.dimensions, 3072, "memory.embedding.dimensions", 1),
				batchSize: readInteger(memoryEmbedding.batch_size, 32, "memory.embedding.batch_size", 1),
			},
			lcm: {
				newSessionRetainDepth: readInteger(
					memoryLcm.new_session_retain_depth,
					2,
					"memory.lcm.new_session_retain_depth",
					-1,
				),
			},
		},
	};
}
