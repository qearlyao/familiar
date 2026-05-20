import {
	clampThinkingLevel,
	findEnvKeys,
	getEnvApiKey,
	getModels,
	getProviders,
	type Model,
	type ModelThinkingLevel,
	type Provider,
} from "@earendil-works/pi-ai";

import { loadAddedModels } from "./added-models.js";
import type { Config, ThinkingLevel } from "./config.js";

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
};

export function parseModelRef(value: string): ModelRef | undefined {
	const trimmed = value.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, separator).trim();
	const id = trimmed.slice(separator + 1).trim();
	if (!provider || !id) return undefined;
	return { provider, id, key: `${provider}/${id}` };
}

function findBuiltInModel(ref: ModelRef): Model<any> | undefined {
	if (!getProviders().includes(ref.provider as any)) return undefined;
	const models = getModels(ref.provider as any) as Model<any>[];
	return models.find((model) => model.id === ref.id);
}

function createFallbackModel(ref: ModelRef): Model<any> {
	const defaults = PROVIDER_DEFAULTS[ref.provider];
	if (!defaults) {
		throw new Error(`Unsupported model provider: ${ref.provider}`);
	}
	return {
		id: ref.id,
		name: ref.id,
		api: defaults.api,
		provider: ref.provider as Provider,
		baseUrl: defaults.baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function applyConfiguredBaseUrl(config: Config, model: Model<any>): Model<any> {
	const baseUrl = config.models.baseUrls[`${model.provider}/${model.id}`] ?? config.models.baseUrls[model.provider];
	return baseUrl ? { ...model, baseUrl } : model;
}

export function resolveModel(ref: ModelRef, config?: Config): Model<any> {
	const model = findBuiltInModel(ref) ?? createFallbackModel(ref);
	return config ? applyConfiguredBaseUrl(config, model) : model;
}

export function createConfiguredModel(config: Config): Model<any> {
	const ref = parseModelRef(config.agent.model);
	if (!ref) throw new Error(`Invalid agent.model: ${config.agent.model}`);
	if (config.agent.api && config.agent.modelId && config.agent.baseUrl) {
		return applyConfiguredBaseUrl(config, {
			id: config.agent.modelId,
			name: config.agent.modelId,
			api: config.agent.api,
			provider: config.agent.provider as Provider,
			baseUrl: config.agent.baseUrl,
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 200000,
			maxTokens: 8192,
		});
	}
	return resolveModel(ref, config);
}

export function resolveModelApiKey(config: Config, model: Model<any>): string | undefined {
	const configuredEnv =
		config.models.apiKeyEnvs[`${model.provider}/${model.id}`] ??
		config.models.apiKeyEnvs[model.provider] ??
		(model.provider === config.agent.provider ? config.agent.apiKeyEnv : undefined);
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

export function modelCanAuthenticate(config: Config, model: Model<any>): boolean {
	if (model.provider === "google-vertex")
		return resolveModelApiKey(config, model) !== undefined || hasVertexAdcEnvironment();
	return !requiresExplicitApiKey(config, model);
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
	const configuredEnv =
		config.models.apiKeyEnvs[`${model.provider}/${model.id}`] ??
		config.models.apiKeyEnvs[model.provider] ??
		(model.provider === config.agent.provider ? config.agent.apiKeyEnv : undefined);
	if (configuredEnv) return configuredEnv;
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

export function formatAllowedModels(config: Config): string {
	return config.models.allow.length > 0 ? config.models.allow.join("\n") : "(no allowlist configured)";
}

export function clampConfiguredThinkingLevel(model: Model<any>, level: ThinkingLevel): ThinkingLevel {
	if (level === "off") return "off";
	return clampThinkingLevel(model, level) as ThinkingLevel;
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	);
}

export function supportedThinkingLevels(model: Model<any>): ModelThinkingLevel[] {
	return model.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh"] : ["off"];
}
