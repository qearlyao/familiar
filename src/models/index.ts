import {
	type BuiltinProvider,
	clampThinkingLevel,
	findEnvKeys,
	getEnvApiKey,
	getModels,
	getProviders,
	getSupportedThinkingLevels,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { THINKING_LEVELS } from "../config/enums.js";
import type { Config, ConfiguredModelInput, ConfiguredProviderDefinition, ThinkingLevel } from "../config/index.js";
import { loadAddedModels } from "./added-models.js";

export interface ModelRef {
	provider: string;
	id: string;
	key: string;
}

export const PROVIDER_DEFAULTS: Record<string, { api: string; baseUrl: string }> = {
	anthropic: {
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
	},
	google: {
		api: "google-generative-ai",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	},
	"google-vertex": {
		api: "google-vertex",
		baseUrl: "https://{location}-aiplatform.googleapis.com",
	},
	openai: {
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
	},
	groq: {
		api: "openai-completions",
		baseUrl: "https://api.groq.com/openai/v1",
	},
	xai: {
		api: "openai-completions",
		baseUrl: "https://api.x.ai/v1",
	},
};

const DEFAULT_REASONING = true;
const DEFAULT_INPUT: Array<"text" | "image"> = ["text", "image"];
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 8192;
const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
} as const;
const BUILT_IN_PROVIDERS = new Set<string>(getProviders());

interface ModelShapeOverrides {
	name?: string;
	reasoning?: boolean;
	input?: ConfiguredModelInput[];
	contextWindow?: number;
	maxTokens?: number;
	compat?: NonNullable<Model<"anthropic-messages">["compat"]>;
}

export function parseModelRef(value: string): ModelRef | undefined {
	const trimmed = value.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, separator).trim();
	const id = trimmed.slice(separator + 1).trim();
	if (!provider || !id) return undefined;
	return { provider, id, key: `${provider}/${id}` };
}

export function isBuiltInProvider(provider: string): provider is BuiltinProvider {
	return BUILT_IN_PROVIDERS.has(provider);
}

export function isBuiltInOrDefaultProvider(provider: string): boolean {
	return isBuiltInProvider(provider) || Object.hasOwn(PROVIDER_DEFAULTS, provider);
}

function findBuiltInModel(ref: ModelRef): Model<any> | undefined {
	if (!isBuiltInProvider(ref.provider)) return undefined;
	const models = getModels(ref.provider) as Model<any>[];
	return models.find((model) => model.id === ref.id);
}

function createBaseModel(ref: ModelRef, api: string, baseUrl: string): Model<any> {
	return {
		id: ref.id,
		name: ref.id,
		api,
		provider: ref.provider,
		baseUrl,
		reasoning: DEFAULT_REASONING,
		input: DEFAULT_INPUT,
		cost: ZERO_COST,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

function synthesizeConfiguredModel(
	ref: ModelRef,
	api: string,
	baseUrl: string,
	...overrides: Array<ModelShapeOverrides | undefined>
): Model<any> {
	let model = createBaseModel(ref, api, baseUrl);
	for (const override of overrides) {
		if (override) model = applyModelShapeOverrides(model, override);
	}
	return model;
}

function createFallbackModel(ref: ModelRef): Model<any> {
	const defaults = PROVIDER_DEFAULTS[ref.provider];
	if (!defaults) {
		throw new Error(`Unsupported model provider: ${ref.provider}`);
	}
	return synthesizeConfiguredModel(ref, defaults.api, defaults.baseUrl);
}

function applyConfiguredBaseUrl(config: Config, model: Model<any>): Model<any> {
	const baseUrl = resolveProviderSetting(config.models.baseUrls, model.provider, model.id);
	return baseUrl ? { ...model, baseUrl } : model;
}

function applyModelShapeOverrides(model: Model<any>, override: ModelShapeOverrides): Model<any> {
	const compat =
		override.compat !== undefined
			? {
					compat: {
						...((model as { compat?: NonNullable<Model<"anthropic-messages">["compat"]> }).compat ?? {}),
						...override.compat,
					},
				}
			: {};
	return {
		...model,
		...(override.name !== undefined ? { name: override.name } : {}),
		...(override.reasoning !== undefined ? { reasoning: override.reasoning } : {}),
		...(override.input !== undefined ? { input: override.input } : {}),
		...(override.contextWindow !== undefined ? { contextWindow: override.contextWindow } : {}),
		...(override.maxTokens !== undefined ? { maxTokens: override.maxTokens } : {}),
		...compat,
	};
}

function resolveConfiguredProviderModel(
	config: Config,
	ref: ModelRef,
	providerConfig: ConfiguredProviderDefinition,
): Model<any> {
	const api = providerConfig.api;
	if (!api) {
		throw new Error(`Missing API for configured provider ${ref.provider}. Set models.providers.${ref.provider}.api.`);
	}
	const baseUrl = resolveProviderSetting(config.models.baseUrls, ref.provider, ref.id);
	if (!baseUrl) {
		throw new Error(`Missing model base URL for ${ref.key}. Set models.base_urls.${ref.provider}.`);
	}
	const override = providerConfig.models.find((model) => model.id === ref.id);
	return synthesizeConfiguredModel(
		ref,
		api,
		baseUrl,
		{
			...(providerConfig.reasoning !== undefined ? { reasoning: providerConfig.reasoning } : {}),
			...(providerConfig.input !== undefined ? { input: providerConfig.input } : {}),
			...(providerConfig.contextWindow !== undefined ? { contextWindow: providerConfig.contextWindow } : {}),
			...(providerConfig.maxTokens !== undefined ? { maxTokens: providerConfig.maxTokens } : {}),
			...(providerConfig.compat !== undefined ? { compat: providerConfig.compat } : {}),
		},
		override,
	);
}

export function resolveModel(ref: ModelRef, config?: Config): Model<any> {
	const builtInModel = findBuiltInModel(ref);
	if (builtInModel) return config ? applyConfiguredBaseUrl(config, builtInModel) : builtInModel;
	const providerConfig = config?.models.providers[ref.provider];
	if (config && providerConfig) return resolveConfiguredProviderModel(config, ref, providerConfig);
	const model = createFallbackModel(ref);
	return config ? applyConfiguredBaseUrl(config, model) : model;
}

export function createConfiguredModel(config: Config): Model<any> {
	const ref = parseModelRef(config.agent.model);
	if (!ref) throw new Error(`Invalid agent.model: ${config.agent.model}`);
	return resolveModel(ref, config);
}

export function resolveProviderSetting(
	records: Record<string, string>,
	provider: string,
	modelId: string,
): string | undefined {
	return records[`${provider}/${modelId}`] ?? records[provider];
}

export function resolveModelApiKey(config: Config, model: Model<any>): string | undefined {
	const configuredEnv = resolveProviderSetting(config.models.apiKeyEnvs, model.provider, model.id);
	if (configuredEnv) return process.env[configuredEnv];
	return getEnvApiKey(model.provider);
}

export function requiresExplicitApiKey(config: Config, model: Model<any>): boolean {
	if (model.provider === "google-vertex") return false;
	return resolveModelApiKey(config, model) === undefined;
}

function hasVertexAdcEnvironment(): boolean {
	const project = process.env.GOOGLE_CLOUD_PROJECT?.trim() || process.env.GCLOUD_PROJECT?.trim();
	const location = process.env.GOOGLE_CLOUD_LOCATION?.trim();
	return !!project && !!location;
}

export function assertModelCanAuthenticate(config: Config, model: Model<any>): void {
	if (model.provider === "google-vertex") {
		if (resolveModelApiKey(config, model) !== undefined || hasVertexAdcEnvironment()) return;
		throw new Error(`Missing Vertex auth for ${model.provider}/${model.id}: ${describeModelAuth(config, model)}`);
	}
	if (requiresExplicitApiKey(config, model)) {
		throw new Error(`Missing API key for ${model.provider}/${model.id}: ${describeModelAuth(config, model)}`);
	}
}

export function describeModelAuth(config: Config, model: Model<any>): string {
	const configuredEnv = resolveProviderSetting(config.models.apiKeyEnvs, model.provider, model.id);
	if (configuredEnv) return configuredEnv;
	if (config.models.providers[model.provider]) return `models.api_key_envs.${model.provider}`;
	if (model.provider === "google-vertex") {
		return "set GOOGLE_CLOUD_API_KEY, or use Vertex ADC with GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT and GOOGLE_CLOUD_LOCATION";
	}
	const envKeys = findEnvKeys(model.provider);
	if (envKeys?.length) return envKeys.join(", ");
	return "no matching API key environment variable found";
}

export function isAllowedModel(config: Config, ref: ModelRef): boolean {
	return (
		config.models.allow.length === 0 || config.models.allow.includes(ref.key) || loadAddedModels().includes(ref.key)
	);
}

export function clampConfiguredThinkingLevel(model: Model<any>, level: ThinkingLevel): ThinkingLevel {
	if (level === "off") return "off";
	return clampThinkingLevel(model, level) as ThinkingLevel;
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function supportedThinkingLevels(model: Model<any>): ThinkingLevel[] {
	return getSupportedThinkingLevels(model);
}
