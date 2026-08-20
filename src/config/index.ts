import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "smol-toml";
import { isBuiltInOrDefaultProvider, resolveProviderSetting } from "../models/index.js";
import { isOpenRouterAnthropicBaseUrl } from "../models/openrouter-routing.js";
import { readEnum } from "../util/guards.js";
import {
	BROWSER_BACKENDS,
	BROWSER_HARNESS_MODES,
	BROWSER_WINDOW_MODES,
	CACHE_RETENTIONS,
	DEFAULT_PLATFORMS,
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
	readConfigTable,
	readConfigTableArray,
	readFraction,
	readInteger,
	readIntegerInRange,
	readNumberInRange,
	readOptionalConfigString,
	readOptionalInteger,
	readOptionalIntegerInRange,
	readOptionalString,
	readPositiveNumber,
	readString,
	readStringArray,
	readStringRecord,
	resolveWorkspacePath,
} from "./readers.js";
import { defaultBrowserAllowedSites, readCronJobs, readPromptOverrides } from "./sections.js";
import type {
	AnthropicModelCompat,
	BrowserHarnessMode,
	BrowserHarnessTargetConfig,
	Config,
	ConfiguredModelDefinition,
	ConfiguredModelInput,
	ConfiguredProviderDefinition,
	OpenRouterRoutingConfig,
} from "./types.js";

export type {
	BrowserBackend,
	BrowserHarnessMode,
	BrowserHarnessTargetConfig,
	CacheRetention,
	Config,
	ConfiguredModelDefinition,
	ConfiguredModelInput,
	ConfiguredProviderDefinition,
	CronDeliveryMode,
	CronFrequency,
	DefaultPlatform,
	DiscordChannelTrigger,
	DiscordChunkMode,
	DiscordDispatchMode,
	DiscordReplyMode,
	ImageGenApi,
	MediaUnderstandingProvider,
	MemoryEmbeddingFormat,
	OpenRouterRoutingConfig,
	ThinkingLevel,
	TtsProvider,
	TtsVoiceSettings,
	WebAuthMode,
} from "./types.js";

const DEFAULT_MEMORY_EMBEDDING_BASE_URLS: Record<string, string> = {
	google: "https://generativelanguage.googleapis.com/v1beta",
};

const DEFAULT_MEMORY_EMBEDDING_API_KEY_ENVS: Record<string, string> = {
	google: "GEMINI_API_KEY",
};

type BrowserHarnessFlatConfig = {
	mode: BrowserHarnessMode;
	cdpUrl?: string;
	cdpWs?: string;
	launchCommand?: string;
	launchArgs: string[];
	cloudApiKeyEnv: string;
	cloudProfileId?: string;
	cloudProfileName?: string;
	cloudTimeoutMinutes?: number;
	cloudProxyCountryCode?: string;
};

function rejectDefined(path: string, value: unknown, mode: BrowserHarnessMode): void {
	if (value !== undefined) throw new Error(`Config value ${path} is only valid when browser.harness_mode = "${mode}"`);
}

function readBrowserHarnessTarget(browser: Record<string, unknown>): BrowserHarnessTargetConfig {
	const mode = readEnum(
		readOptionalString(browser.harness_mode, "attach"),
		"browser.harness_mode",
		BROWSER_HARNESS_MODES,
	);
	const flat: BrowserHarnessFlatConfig = {
		mode,
		cdpUrl: readOptionalConfigString(browser.harness_cdp_url, "browser.harness_cdp_url"),
		cdpWs: readOptionalConfigString(browser.harness_cdp_ws, "browser.harness_cdp_ws"),
		launchCommand: readOptionalConfigString(browser.harness_launch_command, "browser.harness_launch_command"),
		launchArgs: readStringArray(browser.harness_launch_args, "browser.harness_launch_args"),
		cloudApiKeyEnv: readOptionalString(browser.harness_cloud_api_key_env, "BROWSER_USE_API_KEY"),
		cloudProfileId: readOptionalConfigString(browser.harness_cloud_profile_id, "browser.harness_cloud_profile_id"),
		cloudProfileName: readOptionalConfigString(
			browser.harness_cloud_profile_name,
			"browser.harness_cloud_profile_name",
		),
		cloudTimeoutMinutes: readOptionalIntegerInRange(
			browser.harness_cloud_timeout_minutes,
			"browser.harness_cloud_timeout_minutes",
			1,
			240,
		),
		cloudProxyCountryCode: readOptionalConfigString(
			browser.harness_cloud_proxy_country_code,
			"browser.harness_cloud_proxy_country_code",
		),
	};

	if (flat.cdpUrl && flat.cdpWs) {
		throw new Error("Use browser.harness_cdp_url or browser.harness_cdp_ws, not both.");
	}
	if (flat.cloudProfileId && flat.cloudProfileName) {
		throw new Error("Use browser.harness_cloud_profile_id or browser.harness_cloud_profile_name, not both.");
	}
	if (flat.launchArgs.length > 0 && !flat.launchCommand) {
		throw new Error("Config value browser.harness_launch_args requires browser.harness_launch_command.");
	}
	if (flat.launchCommand && !flat.cdpUrl) {
		throw new Error("Config value browser.harness_launch_command requires browser.harness_cdp_url.");
	}

	const rejectCdpFields = () => {
		rejectDefined("browser.harness_cdp_url", flat.cdpUrl, "cdp");
		rejectDefined("browser.harness_cdp_ws", flat.cdpWs, "cdp");
		rejectDefined("browser.harness_launch_command", flat.launchCommand, "cdp");
		if (browser.harness_launch_args !== undefined)
			rejectDefined("browser.harness_launch_args", flat.launchArgs, "cdp");
	};
	const rejectCloudFields = () => {
		if (browser.harness_cloud_api_key_env !== undefined) {
			rejectDefined("browser.harness_cloud_api_key_env", flat.cloudApiKeyEnv, "cloud");
		}
		rejectDefined("browser.harness_cloud_profile_id", flat.cloudProfileId, "cloud");
		rejectDefined("browser.harness_cloud_profile_name", flat.cloudProfileName, "cloud");
		rejectDefined("browser.harness_cloud_timeout_minutes", flat.cloudTimeoutMinutes, "cloud");
		rejectDefined("browser.harness_cloud_proxy_country_code", flat.cloudProxyCountryCode, "cloud");
	};

	switch (flat.mode) {
		case "attach":
			rejectCdpFields();
			rejectCloudFields();
			return { mode: "attach" };
		case "cdp":
			if (!flat.cdpUrl && !flat.cdpWs) {
				throw new Error('browser.harness_mode = "cdp" requires browser.harness_cdp_url or browser.harness_cdp_ws.');
			}
			rejectCloudFields();
			return {
				mode: "cdp",
				cdpUrl: flat.cdpUrl,
				cdpWs: flat.cdpWs,
				launchCommand: flat.launchCommand,
				launchArgs: flat.launchArgs,
			};
		case "cloud":
			rejectCdpFields();
			return {
				mode: "cloud",
				apiKeyEnv: flat.cloudApiKeyEnv,
				profileId: flat.cloudProfileId,
				profileName: flat.cloudProfileName,
				timeoutMinutes: flat.cloudTimeoutMinutes,
				proxyCountryCode: flat.cloudProxyCountryCode,
			};
	}
}

function readConfiguredModelInputs(value: unknown, path: string): ConfiguredModelInput[] | undefined {
	if (value === undefined) return undefined;
	const input = readStringArray(value, path);
	for (const entry of input) {
		if (entry !== "text" && entry !== "image") {
			throw new Error(`Config value ${path} entries must be "text" or "image"`);
		}
	}
	return input as ConfiguredModelInput[];
}

function readOptionalBoolean(value: unknown, path: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`Config value ${path} must be a boolean`);
	return value;
}

function readConfiguredAnthropicCompat(value: unknown, path: string): AnthropicModelCompat | undefined {
	if (value === undefined) return undefined;
	const compat = readConfigTable(value, path);
	assertKnownKeys(compat, path, [
		"supports_eager_tool_input_streaming",
		"supports_long_cache_retention",
		"send_session_affinity_headers",
		"supports_cache_control_on_tools",
		"supports_temperature",
		"force_adaptive_thinking",
		"allow_empty_signature",
	]);
	const supportsEagerToolInputStreaming = readOptionalBoolean(
		compat.supports_eager_tool_input_streaming,
		`${path}.supports_eager_tool_input_streaming`,
	);
	const supportsLongCacheRetention = readOptionalBoolean(
		compat.supports_long_cache_retention,
		`${path}.supports_long_cache_retention`,
	);
	const sendSessionAffinityHeaders = readOptionalBoolean(
		compat.send_session_affinity_headers,
		`${path}.send_session_affinity_headers`,
	);
	const supportsCacheControlOnTools = readOptionalBoolean(
		compat.supports_cache_control_on_tools,
		`${path}.supports_cache_control_on_tools`,
	);
	const supportsTemperature = readOptionalBoolean(compat.supports_temperature, `${path}.supports_temperature`);
	const forceAdaptiveThinking = readOptionalBoolean(compat.force_adaptive_thinking, `${path}.force_adaptive_thinking`);
	const allowEmptySignature = readOptionalBoolean(compat.allow_empty_signature, `${path}.allow_empty_signature`);
	return {
		...(supportsEagerToolInputStreaming !== undefined ? { supportsEagerToolInputStreaming } : {}),
		...(supportsLongCacheRetention !== undefined ? { supportsLongCacheRetention } : {}),
		...(sendSessionAffinityHeaders !== undefined ? { sendSessionAffinityHeaders } : {}),
		...(supportsCacheControlOnTools !== undefined ? { supportsCacheControlOnTools } : {}),
		...(supportsTemperature !== undefined ? { supportsTemperature } : {}),
		...(forceAdaptiveThinking !== undefined ? { forceAdaptiveThinking } : {}),
		...(allowEmptySignature !== undefined ? { allowEmptySignature } : {}),
	};
}

function readConfiguredModelDefinition(value: Record<string, unknown>, path: string): ConfiguredModelDefinition {
	assertKnownKeys(value, path, ["id", "name", "reasoning", "input", "context_window", "max_tokens", "compat"]);
	const name = readOptionalConfigString(value.name, `${path}.name`);
	const input = readConfiguredModelInputs(value.input, `${path}.input`);
	const contextWindow = readOptionalInteger(value.context_window, `${path}.context_window`, 1);
	const maxTokens = readOptionalInteger(value.max_tokens, `${path}.max_tokens`, 1);
	const compat = readConfiguredAnthropicCompat(value.compat, `${path}.compat`);
	return {
		id: readString(value.id, `${path}.id`),
		...(name !== undefined ? { name } : {}),
		...(value.reasoning !== undefined ? { reasoning: readBoolean(value.reasoning, false, `${path}.reasoning`) } : {}),
		...(input !== undefined ? { input } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(compat !== undefined ? { compat } : {}),
	};
}

function assertValidConfiguredProviderName(providerName: string, path: string): void {
	if (!providerName.trim()) {
		throw new Error(`Config value ${path} provider name must not be empty`);
	}
	if (providerName.includes("/")) {
		throw new Error(`Config value ${path} provider name must not contain "/"; use a bare provider name`);
	}
}

function readConfiguredProviders(value: unknown): Record<string, ConfiguredProviderDefinition> {
	const providers = readConfigTable(value, "models.providers");
	const configured: Record<string, ConfiguredProviderDefinition> = {};
	for (const [providerName, rawProvider] of Object.entries(providers)) {
		const path = `models.providers.${providerName}`;
		assertValidConfiguredProviderName(providerName, path);
		if (isBuiltInOrDefaultProvider(providerName)) {
			throw new Error(
				`Config value ${path} is only for custom providers. Use models.base_urls/models.api_key_envs for built-in providers.`,
			);
		}
		const provider = readConfigTable(rawProvider, path);
		assertKnownKeys(provider, path, [
			"api",
			"reasoning",
			"input",
			"context_window",
			"max_tokens",
			"compat",
			"models",
		]);
		const api = readOptionalConfigString(provider.api, `${path}.api`);
		const input = readConfiguredModelInputs(provider.input, `${path}.input`);
		const contextWindow = readOptionalInteger(provider.context_window, `${path}.context_window`, 1);
		const maxTokens = readOptionalInteger(provider.max_tokens, `${path}.max_tokens`, 1);
		const compat = readConfiguredAnthropicCompat(provider.compat, `${path}.compat`);
		const models = readConfigTableArray(provider.models, `${path}.models`).map((entry, index) =>
			readConfiguredModelDefinition(entry, `${path}.models[${index}]`),
		);
		if (
			(compat !== undefined || models.some((model) => model.compat !== undefined)) &&
			api !== "anthropic-messages"
		) {
			throw new Error(`Config value ${path}.compat is only valid when ${path}.api = "anthropic-messages"`);
		}
		const seenModelIds = new Set<string>();
		for (const model of models) {
			if (seenModelIds.has(model.id)) {
				throw new Error(`Duplicate configured model id for provider ${providerName}: ${model.id}`);
			}
			seenModelIds.add(model.id);
		}
		configured[providerName] = {
			...(api !== undefined ? { api } : {}),
			...(provider.reasoning !== undefined
				? { reasoning: readBoolean(provider.reasoning, false, `${path}.reasoning`) }
				: {}),
			...(input !== undefined ? { input } : {}),
			...(contextWindow !== undefined ? { contextWindow } : {}),
			...(maxTokens !== undefined ? { maxTokens } : {}),
			...(compat !== undefined ? { compat } : {}),
			models,
		};
	}
	return configured;
}

function readOpenRouterRouting(
	value: unknown,
	baseUrls: Record<string, string>,
): Record<string, OpenRouterRoutingConfig> {
	const entries = readConfigTable(value, "models.openrouter_routing");
	const routing: Record<string, OpenRouterRoutingConfig> = {};
	for (const [target, rawEntry] of Object.entries(entries)) {
		const path = `models.openrouter_routing.${target}`;
		const ref = target === "anthropic" ? undefined : maybeParseProviderModelRef(target);
		if (target !== "anthropic" && ref?.provider !== "anthropic") {
			throw new Error(`Config value ${path} must target anthropic or anthropic/<model>`);
		}
		const entry = readConfigTable(rawEntry, path);
		assertKnownKeys(entry, path, ["order", "allow_fallbacks"]);
		const order = readStringArray(entry.order, `${path}.order`).map((provider) => provider.trim());
		if (order.length === 0 || order.some((provider) => provider === "")) {
			throw new Error(`Config value ${path}.order must be a non-empty string array`);
		}
		const baseUrl = ref ? resolveProviderSetting(baseUrls, ref.provider, ref.modelId) : baseUrls.anthropic;
		if (!baseUrl || !isOpenRouterAnthropicBaseUrl(baseUrl)) {
			throw new Error(`Config value ${path} requires its models.base_urls target to be https://openrouter.ai/api`);
		}
		routing[target] = {
			order,
			allowFallbacks: readBoolean(entry.allow_fallbacks, true, `${path}.allow_fallbacks`),
		};
	}
	if (routing.anthropic) {
		for (const [target, baseUrl] of Object.entries(baseUrls)) {
			const ref = maybeParseProviderModelRef(target);
			if (ref?.provider === "anthropic" && !isOpenRouterAnthropicBaseUrl(baseUrl)) {
				throw new Error(
					`Config value models.openrouter_routing.anthropic applies to ${target}, whose models.base_urls override must be https://openrouter.ai/api`,
				);
			}
		}
	}
	return routing;
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
	const ttsCartesia = (tts.cartesia ?? {}) as Record<string, unknown>;
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
		"harness_mode",
		"opencli_command",
		"harness_command",
		"session",
		"profile",
		"harness_cdp_url",
		"harness_cdp_ws",
		"harness_launch_command",
		"harness_launch_args",
		"harness_cloud_api_key_env",
		"harness_cloud_profile_id",
		"harness_cloud_profile_name",
		"harness_cloud_timeout_minutes",
		"harness_cloud_proxy_country_code",
		"window",
		"timeout_ms",
		"max_output_chars",
		"read_write",
	]);
	const browserHarnessTarget = readBrowserHarnessTarget(browser);
	const memoryEmbedding = (memory.embedding ?? {}) as Record<string, unknown>;
	const memoryAmbient = (memory.ambient ?? {}) as Record<string, unknown>;
	const memoryLcm = (memory.lcm ?? {}) as Record<string, unknown>;
	assertKnownKeys(agent, "agent", ["model", "cache_retention", "thinking_level"]);
	assertKnownKeys(memoryEmbedding, "memory.embedding", [
		"format",
		"provider",
		"model",
		"base_url",
		"api_key_env",
		"dimensions",
		"batch_size",
	]);

	const token = readOptionalConfigString(process.env.DISCORD_TOKEN, "DISCORD_TOKEN");
	const ownerId = readOptionalConfigString(discord.owner_id, "discord.owner_id");
	if (token && !ownerId) throw new Error("Config value discord.owner_id is required when DISCORD_TOKEN is set");
	const defaultPlatform =
		parsed.default_platform === undefined
			? undefined
			: readEnum(parsed.default_platform, "default_platform", DEFAULT_PLATFORMS);
	const agentModel = readString(agent.model, "agent.model").trim();

	const memoryRootDir = resolveWorkspacePath(workspacePath, readOptionalString(memory.root_dir, "memories"));
	assertKnownKeys(models, "models", ["allow", "base_urls", "api_key_envs", "openrouter_routing", "providers"]);
	const modelAllow = readStringArray(models.allow, "models.allow");
	const modelBaseUrls = readStringRecord(models.base_urls, "models.base_urls");
	const modelApiKeyEnvs = readStringRecord(models.api_key_envs, "models.api_key_envs");
	const openRouterRouting = readOpenRouterRouting(models.openrouter_routing, modelBaseUrls);
	const configuredProviders = readConfiguredProviders(models.providers);
	const memoryEmbeddingFormat = readEnum(
		readOptionalString(memoryEmbedding.format, "gemini"),
		"memory.embedding.format",
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
		memoryLcmBaseUrl = resolveProviderSetting(modelBaseUrls, memoryLcmRef.provider, memoryLcmRef.modelId);
		memoryLcmApiKeyEnv = resolveProviderSetting(modelApiKeyEnvs, memoryLcmRef.provider, memoryLcmRef.modelId);
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
		defaultPlatform,
		discord: {
			token,
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
			harnessTarget: browserHarnessTarget,
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
			cacheRetention: readEnum(
				readOptionalString(agent.cache_retention, "long"),
				"agent.cache_retention",
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
			openRouterRouting,
			providers: configuredProviders,
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
			cartesia: {
				apiKeyEnv: readOptionalString(ttsCartesia.api_key_env, "CARTESIA_API_KEY"),
				voiceId: readOptionalString(ttsCartesia.voice_id, ""),
				modelId: readOptionalString(ttsCartesia.model_id, "sonic-3.5"),
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
				baseUrl: readOptionalConfigString(mediaUnderstandingVideo.base_url, "media.understanding.video.base_url"),
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
