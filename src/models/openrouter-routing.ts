import type { OpenRouterRouting } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import { OpenRouterRoutingSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import { compile } from "@earendil-works/pi-schema";
import type { Config } from "../config/types.js";
import { isRecord } from "../util/guards.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** The routing fields pi forwards as OpenRouter's `provider` object (order, sort, only, max_price, ...). */
export const OPENROUTER_ROUTING_KEYS = Object.keys((OpenRouterRoutingSchema as { properties: object }).properties);
const openRouterRoutingValidator = compile(OpenRouterRoutingSchema);

function openRouterPath(baseUrl: string): string | undefined {
	try {
		const url = new URL(baseUrl);
		const clean =
			url.origin === "https://openrouter.ai" &&
			url.username === "" &&
			url.password === "" &&
			url.search === "" &&
			url.hash === "";
		return clean ? url.pathname.replace(/\/+$/, "") : undefined;
	} catch {
		return undefined;
	}
}

/** OpenRouter serves Anthropic Messages at /api and OpenAI Completions at /api/v1. */
const OPENROUTER_PATH_BY_API: Record<string, string> = {
	"anthropic-messages": "/api",
	"openai-completions": "/api/v1",
};

export function isOpenRouterBaseUrl(baseUrl: string): boolean {
	const path = openRouterPath(baseUrl);
	return path !== undefined && Object.values(OPENROUTER_PATH_BY_API).includes(path);
}

export function parseOpenRouterRouting(value: unknown, path: string): OpenRouterRouting {
	const result = openRouterRoutingValidator.validate(value);
	if (result.ok) return result.value;
	const details = result.errors.map((error) => `${path}${error.path.replaceAll("/", ".")}: ${error.message}`);
	throw new Error(`Invalid config value ${path}: ${details.join("; ")}`);
}

function openRouterRoutingOf(model: Model<any>): OpenRouterRouting | undefined {
	return (model.compat as { openRouterRouting?: OpenRouterRouting } | undefined)?.openRouterRouting;
}

/**
 * Puts configured routing on the model's compat.openRouterRouting. Pi sends it as the request's `provider` object on
 * OpenAI Completions; pi's Anthropic Messages path ignores it, so addAnthropicOpenRouterRouting sends it there.
 */
export function applyOpenRouterRouting(config: Config, model: Model<any>): Model<any> {
	const routing =
		config.models.openRouterRouting[`${model.provider}/${model.id}`] ??
		config.models.openRouterRouting[model.provider];
	if (!routing) return model;
	const expectedPath = OPENROUTER_PATH_BY_API[model.api];
	if (!expectedPath) {
		throw new Error(
			`OpenRouter routing for ${model.provider}/${model.id} requires anthropic-messages or openai-completions, received ${model.api}`,
		);
	}
	if (openRouterPath(model.baseUrl) !== expectedPath) {
		throw new Error(
			`OpenRouter routing for ${model.provider}/${model.id} requires https://openrouter.ai${expectedPath} for ${model.api}, received ${model.baseUrl}`,
		);
	}
	return { ...model, compat: { ...model.compat, openRouterRouting: routing } };
}

export function addAnthropicOpenRouterRouting(payload: unknown, model: Model<any>): unknown {
	const routing = openRouterRoutingOf(model);
	if (model.api !== "anthropic-messages" || !routing) return payload;
	if (!isRecord(payload)) throw new Error("OpenRouter request payload must be an object");
	payload.provider = routing;
	return payload;
}
