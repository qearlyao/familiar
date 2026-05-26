import type { Config } from "./config.js";
import { loadConfigOverrides } from "./config-overrides.js";
import type { DiscordDaemon } from "./discord.js";
import { isAllowedModel, parseModelRef, resolveProviderSetting } from "./models.js";

export type ConfigKey =
	| "heartbeat.enabled"
	| "heartbeat.idleThresholdMs"
	| "heartbeat.intervalMs"
	| "image_gen.enabled"
	| "image_gen.model"
	| "image_gen.fallback_model"
	| "memory.lcm.enabled"
	| "memory.lcm.model"
	| "memory.lcm.contextThreshold"
	| "memory.lcm.freshTailCount"
	| "memory.lcm.leafChunkTokens"
	| "memory.lcm.leafTargetTokens"
	| "memory.lcm.condenseGroupSize"
	| "memory.lcm.maxSummaryDepth"
	| "memory.lcm.newSessionRetainDepth"
	| "memory.ambient.enabled"
	| "memory.ambient.topK"
	| "memory.ambient.minQueryLength"
	| "memory.ambient.throttleSeconds"
	| "memory.ambient.weightSimilarity"
	| "memory.ambient.weightValence"
	| "memory.ambient.weightRecency"
	| "memory.ambient.weightIntensity";

export interface RegistryApplyContext {
	config: Config;
	discordDaemon: DiscordDaemon;
}

export interface RegistryEntry {
	read(config: Config): unknown;
	validate(value: unknown, config: Config): unknown;
	write(config: Config, value: unknown): void;
	apply?(ctx: RegistryApplyContext): void | Promise<void>;
}

function requireBoolean(value: unknown, key: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
	return value;
}

function requirePositiveInt(value: unknown, key: string): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
		throw new Error(`${key} must be a positive integer`);
	}
	return n;
}

function requireInt(value: unknown, key: string, min: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
		throw new Error(`${key} must be an integer >= ${min}`);
	}
	return n;
}

function requireNumberInRange(value: unknown, key: string, min: number, max: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n < min || n > max) {
		throw new Error(`${key} must be a number between ${min} and ${max}`);
	}
	return n;
}

function requireNonNegativeInt(value: unknown, key: string): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
		throw new Error(`${key} must be a non-negative integer`);
	}
	return n;
}

function requireNonNegativeNumber(value: unknown, key: string): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n < 0) {
		throw new Error(`${key} must be a number >= 0`);
	}
	return n;
}

export const CONFIG_REGISTRY: Record<ConfigKey, RegistryEntry> = {
	"heartbeat.enabled": {
		read: (config) => config.heartbeat.enabled,
		validate: (value) => requireBoolean(value, "heartbeat.enabled"),
		write: (config, value) => {
			config.heartbeat.enabled = value as boolean;
		},
		apply: ({ discordDaemon }) => {
			discordDaemon.rearmHeartbeat();
		},
	},
	"heartbeat.idleThresholdMs": {
		read: (config) => config.heartbeat.idleThresholdMs,
		validate: (value) => requirePositiveInt(value, "heartbeat.idleThresholdMs"),
		write: (config, value) => {
			config.heartbeat.idleThresholdMs = value as number;
		},
		apply: ({ discordDaemon }) => {
			discordDaemon.rearmHeartbeat();
		},
	},
	"heartbeat.intervalMs": {
		read: (config) => config.heartbeat.intervalMs,
		validate: (value) => requirePositiveInt(value, "heartbeat.intervalMs"),
		write: (config, value) => {
			config.heartbeat.intervalMs = value as number;
		},
		apply: ({ discordDaemon }) => {
			discordDaemon.rearmHeartbeat();
		},
	},
	"image_gen.enabled": {
		read: (config) => config.imageGen.enabled,
		validate: (value) => requireBoolean(value, "image_gen.enabled"),
		write: (config, value) => {
			config.imageGen.enabled = value as boolean;
		},
	},
	"image_gen.model": {
		read: (config) => config.imageGen.model,
		validate: (value) => {
			if (typeof value !== "string") throw new Error("image_gen.model must be a string");
			const ref = parseModelRef(value);
			if (!ref) throw new Error("image_gen.model: format must be provider/model-id");
			return ref.key;
		},
		write: (config, value) => {
			const ref = parseModelRef(value as string);
			if (!ref) return;
			config.imageGen.model = ref.key;
		},
	},
	"image_gen.fallback_model": {
		read: (config) => config.imageGen.fallbackModel ?? "",
		validate: (value) => {
			if (value == null || value === "") return "";
			if (typeof value !== "string") throw new Error("image_gen.fallback_model must be a string");
			const ref = parseModelRef(value);
			if (!ref) throw new Error("image_gen.fallback_model: format must be provider/model-id");
			return ref.key;
		},
		write: (config, value) => {
			if (value == null || value === "") {
				config.imageGen.fallbackModel = undefined;
				return;
			}
			const ref = parseModelRef(value as string);
			if (!ref) return;
			config.imageGen.fallbackModel = ref.key;
		},
	},
	"memory.lcm.enabled": {
		read: (config) => config.memory.lcm.enabled,
		validate: (value) => requireBoolean(value, "memory.lcm.enabled"),
		write: (config, value) => {
			config.memory.lcm.enabled = value as boolean;
		},
	},
	"memory.lcm.model": {
		read: (config) => config.memory.lcm.model,
		validate: (value, config) => {
			if (typeof value !== "string") throw new Error("memory.lcm.model must be a string");
			const ref = parseModelRef(value);
			if (!ref) throw new Error("memory.lcm.model: format must be provider/model-id");
			if (!isAllowedModel(config, ref)) throw new Error(`memory.lcm.model is not allowlisted: ${ref.key}`);
			return ref.key;
		},
		write: (config, value) => {
			const ref = parseModelRef(value as string);
			if (!ref) return;
			config.memory.lcm.model = ref.key;
			config.memory.lcm.provider = ref.provider;
			config.memory.lcm.modelId = ref.id;
			config.memory.lcm.baseUrl = resolveProviderSetting(config.models.baseUrls, ref.provider, ref.id);
			config.memory.lcm.apiKeyEnv = resolveProviderSetting(config.models.apiKeyEnvs, ref.provider, ref.id);
		},
	},
	"memory.lcm.contextThreshold": {
		read: (config) => config.memory.lcm.contextThreshold,
		validate: (value) => requireNumberInRange(value, "memory.lcm.contextThreshold", 0, 1),
		write: (config, value) => {
			config.memory.lcm.contextThreshold = value as number;
		},
	},
	"memory.lcm.freshTailCount": {
		read: (config) => config.memory.lcm.freshTailCount,
		validate: (value) => requirePositiveInt(value, "memory.lcm.freshTailCount"),
		write: (config, value) => {
			config.memory.lcm.freshTailCount = value as number;
		},
	},
	"memory.lcm.leafChunkTokens": {
		read: (config) => config.memory.lcm.leafChunkTokens,
		validate: (value) => requirePositiveInt(value, "memory.lcm.leafChunkTokens"),
		write: (config, value) => {
			config.memory.lcm.leafChunkTokens = value as number;
		},
	},
	"memory.lcm.leafTargetTokens": {
		read: (config) => config.memory.lcm.leafTargetTokens,
		validate: (value) => requirePositiveInt(value, "memory.lcm.leafTargetTokens"),
		write: (config, value) => {
			config.memory.lcm.leafTargetTokens = value as number;
		},
	},
	"memory.lcm.condenseGroupSize": {
		read: (config) => config.memory.lcm.condenseGroupSize,
		validate: (value) => requirePositiveInt(value, "memory.lcm.condenseGroupSize"),
		write: (config, value) => {
			config.memory.lcm.condenseGroupSize = value as number;
		},
	},
	"memory.lcm.maxSummaryDepth": {
		read: (config) => config.memory.lcm.maxSummaryDepth,
		validate: (value) => requirePositiveInt(value, "memory.lcm.maxSummaryDepth"),
		write: (config, value) => {
			config.memory.lcm.maxSummaryDepth = value as number;
		},
	},
	"memory.lcm.newSessionRetainDepth": {
		read: (config) => config.memory.lcm.newSessionRetainDepth,
		validate: (value) => requireInt(value, "memory.lcm.newSessionRetainDepth", -1),
		write: (config, value) => {
			config.memory.lcm.newSessionRetainDepth = value as number;
		},
	},
	"memory.ambient.enabled": {
		read: (config) => config.memory.ambient.enabled,
		validate: (value) => requireBoolean(value, "memory.ambient.enabled"),
		write: (config, value) => {
			config.memory.ambient.enabled = value as boolean;
		},
	},
	"memory.ambient.topK": {
		read: (config) => config.memory.ambient.topK,
		validate: (value) => requirePositiveInt(value, "memory.ambient.topK"),
		write: (config, value) => {
			config.memory.ambient.topK = value as number;
		},
	},
	"memory.ambient.minQueryLength": {
		read: (config) => config.memory.ambient.minQueryLength,
		validate: (value) => requireNonNegativeInt(value, "memory.ambient.minQueryLength"),
		write: (config, value) => {
			config.memory.ambient.minQueryLength = value as number;
		},
	},
	"memory.ambient.throttleSeconds": {
		read: (config) => config.memory.ambient.throttleSeconds,
		validate: (value) => requireNonNegativeInt(value, "memory.ambient.throttleSeconds"),
		write: (config, value) => {
			config.memory.ambient.throttleSeconds = value as number;
		},
	},
	"memory.ambient.weightSimilarity": {
		read: (config) => config.memory.ambient.weightSimilarity,
		validate: (value) => requireNonNegativeNumber(value, "memory.ambient.weightSimilarity"),
		write: (config, value) => {
			config.memory.ambient.weightSimilarity = value as number;
		},
	},
	"memory.ambient.weightValence": {
		read: (config) => config.memory.ambient.weightValence,
		validate: (value) => requireNonNegativeNumber(value, "memory.ambient.weightValence"),
		write: (config, value) => {
			config.memory.ambient.weightValence = value as number;
		},
	},
	"memory.ambient.weightRecency": {
		read: (config) => config.memory.ambient.weightRecency,
		validate: (value) => requireNonNegativeNumber(value, "memory.ambient.weightRecency"),
		write: (config, value) => {
			config.memory.ambient.weightRecency = value as number;
		},
	},
	"memory.ambient.weightIntensity": {
		read: (config) => config.memory.ambient.weightIntensity,
		validate: (value) => requireNonNegativeNumber(value, "memory.ambient.weightIntensity"),
		write: (config, value) => {
			config.memory.ambient.weightIntensity = value as number;
		},
	},
};

export const CONFIG_KEYS = Object.keys(CONFIG_REGISTRY) as ConfigKey[];

export function isConfigKey(value: unknown): value is ConfigKey {
	return typeof value === "string" && value in CONFIG_REGISTRY;
}

const defaultSnapshot = new Map<ConfigKey, unknown>();

export function snapshotConfigDefaults(config: Config): void {
	defaultSnapshot.clear();
	for (const key of CONFIG_KEYS) {
		defaultSnapshot.set(key, CONFIG_REGISTRY[key].read(config));
	}
}

export function getConfigDefault(key: ConfigKey): unknown {
	return defaultSnapshot.get(key);
}

export function applyConfigOverridesToConfig(config: Config): void {
	snapshotConfigDefaults(config);
	const overrides = loadConfigOverrides();
	for (const [key, value] of Object.entries(overrides)) {
		if (!isConfigKey(key)) continue;
		const entry = CONFIG_REGISTRY[key];
		try {
			const validated = entry.validate(value, config);
			entry.write(config, validated);
		} catch (error) {
			console.warn(`Skipping invalid config override ${key}:`, error);
		}
	}
}
