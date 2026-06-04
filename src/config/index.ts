import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "smol-toml";
import { resolveProviderSetting } from "../models.js";
import { readEnum } from "../util/guards.js";
import {
	BROWSER_BACKENDS,
	BROWSER_WINDOW_MODES,
	CACHE_RETENTIONS,
	DISCORD_CHANNEL_TRIGGERS,
	DISCORD_CHUNK_MODES,
	DISCORD_DISPATCH_MODES,
	DISCORD_REPLY_MODES,
	IMAGE_GEN_APIS,
	MEDIA_UNDERSTANDING_PROVIDERS,
	MEMORY_EMBEDDING_FORMATS,
	THINKING_LEVELS,
	TTS_PROVIDERS,
	WEB_AUTH_MODES,
} from "./enums.js";
import { interpolateValue } from "./interpolate.js";
import { maybeParseProviderModelRef, parseProviderModelRef } from "./model-refs.js";
import {
	assertKnownKeys,
	readBoolean,
	readConfigString,
	readFraction,
	readInteger,
	readIntegerInRange,
	readNumberInRange,
	readOptionalConfigString,
	readOptionalInteger,
	readOptionalString,
	readPositiveNumber,
	readString,
	readStringArray,
	readStringRecord,
	resolveWorkspacePath,
} from "./readers.js";
import { defaultBrowserAllowedSites, readCronJobs, readPromptOverrides } from "./sections.js";
import type { Config } from "./types.js";

export type {
	BrowserBackend,
	CacheRetention,
	Config,
	CronDeliveryMode,
	CronFrequency,
	DiscordChannelTrigger,
	DiscordChunkMode,
	DiscordDispatchMode,
	DiscordReplyMode,
	ImageGenApi,
	MediaUnderstandingProvider,
	MemoryEmbeddingFormat,
	ThinkingLevel,
	TtsProvider,
	TtsVoiceSettings,
	WebAuthMode,
} from "./types.js";

const loggedConfigWarnings = new Set<string>();

const DEFAULT_MEMORY_EMBEDDING_BASE_URLS: Record<string, string> = {
	google: "https://generativelanguage.googleapis.com/v1beta",
};

const DEFAULT_MEMORY_EMBEDDING_API_KEY_ENVS: Record<string, string> = {
	google: "GEMINI_API_KEY",
};

function warnOnce(key: string, message: string): void {
	if (loggedConfigWarnings.has(key)) return;
	loggedConfigWarnings.add(key);
	console.warn(message);
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
	const browser = (parsed.browser ?? {}) as Record<string, unknown>;
	const agent = (parsed.agent ?? {}) as Record<string, unknown>;
	const heartbeat = (parsed.heartbeat ?? {}) as Record<string, unknown>;
	const cron = (parsed.cron ?? {}) as Record<string, unknown>;
	const models = (parsed.models ?? {}) as Record<string, unknown>;
	const tts = (parsed.tts ?? {}) as Record<string, unknown>;
	const ttsVoiceSettings = (tts.voice_settings ?? {}) as Record<string, unknown>;
	const imageGen = (parsed.image_gen ?? {}) as Record<string, unknown>;
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
	assertKnownKeys(browser, "browser", [
		"enabled",
		"backend",
		"opencli_command",
		"harness_command",
		"session",
		"profile",
		"window",
		"timeout_ms",
		"max_output_chars",
		"read_write",
	]);
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
	const memoryEmbeddingFormat = readEnum(
		readOptionalString(memoryEmbeddingFormatRaw, "gemini"),
		memoryEmbedding.format === undefined && memoryEmbedding.api !== undefined
			? "memory.embedding.api"
			: "memory.embedding.format",
		MEMORY_EMBEDDING_FORMATS,
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
			token: readOptionalConfigString(process.env.DISCORD_TOKEN, "DISCORD_TOKEN"),
			ownerId,
			allowedChannels: readStringArray(discord.allowed_channels, "discord.allowed_channels"),
			replyMode: readEnum(
				readOptionalString(discord.reply_mode, "plain"),
				"discord.reply_mode",
				DISCORD_REPLY_MODES,
			),
			chunkMode: readEnum(
				readOptionalString(discord.chunk_mode, "paragraph"),
				"discord.chunk_mode",
				DISCORD_CHUNK_MODES,
			),
			dmMode: readEnum(readOptionalString(discord.dm_mode, "steer"), "discord.dm_mode", DISCORD_DISPATCH_MODES),
			channelMode: readEnum(
				readOptionalString(discord.channel_mode, "collect"),
				"discord.channel_mode",
				DISCORD_DISPATCH_MODES,
			),
			channelTrigger: readEnum(
				readOptionalString(discord.channel_trigger, "mention"),
				"discord.channel_trigger",
				DISCORD_CHANNEL_TRIGGERS,
			),
			collectDebounceMs: readInteger(discord.collect_debounce_ms, 4000, "discord.collect_debounce_ms"),
			allowBotMessages: readBoolean(discord.allow_bot_messages, false, "discord.allow_bot_messages"),
		},
		web: {
			port: readInteger(web.port, 8787, "web.port"),
			authMode: readEnum(readOptionalString(web.auth_mode, "tailscale-only"), "web.auth_mode", WEB_AUTH_MODES),
			bearerToken: readOptionalString(web.bearer_token, "") || undefined,
			totpSecret: readOptionalString(web.totp_secret, "") || undefined,
			bindAddress: readOptionalString(web.bind_address, "127.0.0.1"),
		},
		browser: {
			enabled: readBoolean(browser.enabled, false, "browser.enabled"),
			backend: readEnum(readOptionalString(browser.backend, "opencli"), "browser.backend", BROWSER_BACKENDS),
			opencliCommand: readOptionalString(browser.opencli_command, "opencli"),
			harnessCommand: readOptionalString(browser.harness_command, "browser-harness"),
			session: readOptionalString(browser.session, "familiar"),
			profile: readOptionalString(browser.profile, "") || undefined,
			windowMode: readEnum(readOptionalString(browser.window, "background"), "browser.window", BROWSER_WINDOW_MODES),
			timeoutMs: readInteger(browser.timeout_ms, 60_000, "browser.timeout_ms", 1),
			maxOutputChars: readInteger(browser.max_output_chars, 12_000, "browser.max_output_chars", 1000),
			readWrite: readBoolean(browser.read_write, false, "browser.read_write"),
			allowedSites: defaultBrowserAllowedSites(),
		},
		agent: {
			model: agentModel,
			api: usingLegacyAgentModel ? api : undefined,
			modelId: usingLegacyAgentModel ? modelId : undefined,
			baseUrl: usingLegacyAgentModel ? baseUrl : undefined,
			apiKeyEnv: usingLegacyAgentModel ? apiKeyEnv : undefined,
			provider: usingLegacyAgentModel ? provider : undefined,
			cacheRetention: readEnum(
				readOptionalString(agentCacheRetentionRaw, "long"),
				agent.cache_retention === undefined && agent.cacheRetention !== undefined
					? "agent.cacheRetention"
					: "agent.cache_retention",
				CACHE_RETENTIONS,
			),
			thinkingLevel: readEnum(
				readOptionalString(agent.thinking_level, "medium"),
				"agent.thinking_level",
				THINKING_LEVELS,
			),
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
			provider: readEnum(readOptionalString(tts.provider, "elevenlabs"), "tts.provider", TTS_PROVIDERS),
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
		imageGen: {
			enabled: readBoolean(imageGen.enabled, true, "image_gen.enabled"),
			model: readConfigString(imageGen.model, "openrouter/google/gemini-2.5-flash-image", "image_gen.model"),
			fallbackModel: readOptionalConfigString(imageGen.fallback_model, "image_gen.fallback_model"),
			api: readEnum(readOptionalString(imageGen.api, "openrouter-images"), "image_gen.api", IMAGE_GEN_APIS),
			timeoutMs: readInteger(imageGen.timeout_ms, 120_000, "image_gen.timeout_ms", 1),
		},
		mediaUnderstanding: {
			audio: {
				provider: readEnum(
					readOptionalString(mediaUnderstandingAudio.provider, "groq"),
					"media.understanding.audio.provider",
					MEDIA_UNDERSTANDING_PROVIDERS,
				),
				model: readOptionalString(mediaUnderstandingAudio.model, "whisper-large-v3"),
				apiKeyEnv: readOptionalString(mediaUnderstandingAudio.api_key_env, "GROQ_API_KEY"),
			},
			video: {
				provider: readEnum(
					readOptionalString(mediaUnderstandingVideo.provider, "google"),
					"media.understanding.video.provider",
					MEDIA_UNDERSTANDING_PROVIDERS,
				),
				model: readOptionalString(mediaUnderstandingVideo.model, "gemini-3-flash-preview"),
				apiKeyEnv: readOptionalString(mediaUnderstandingVideo.api_key_env, "GEMINI_API_KEY"),
			},
		},
		persona: {
			soul: resolveWorkspacePath(workspacePath, readOptionalString(persona.soul, "SOUL.md")),
			user: resolveWorkspacePath(workspacePath, readOptionalString(persona.user, "USER.md")),
			contact: resolveWorkspacePath(workspacePath, readOptionalString(persona.contact, "CONTACT.md")),
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
