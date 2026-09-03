import type { Model } from "@earendil-works/pi-ai/compat";
import type { Config, OpenRouterRoutingConfig } from "../config/types.js";
import { isRecord } from "../util/guards.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function isOpenRouterBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return (
			url.origin === "https://openrouter.ai" &&
			url.username === "" &&
			url.password === "" &&
			["/api", "/api/v1"].includes(url.pathname.replace(/\/+$/, "")) &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

export function isOpenRouterAnthropicBaseUrl(baseUrl: string): boolean {
	return isOpenRouterBaseUrl(baseUrl) && new URL(baseUrl).pathname.replace(/\/+$/, "") === "/api";
}

export function resolveOpenRouterRouting(config: Config, model: Model<any>): OpenRouterRoutingConfig | undefined {
	return (
		config.models.openRouterRouting[`${model.provider}/${model.id}`] ??
		config.models.openRouterRouting[model.provider]
	);
}

export function addOpenRouterRouting(
	payload: unknown,
	model: Model<any>,
	routing: OpenRouterRoutingConfig | undefined,
): unknown {
	if (!routing) return payload;
	if (model.api !== "anthropic-messages" && model.api !== "openai-completions") {
		throw new Error(`OpenRouter routing requires anthropic-messages or openai-completions, received ${model.api}`);
	}
	const validBaseUrl =
		model.api === "anthropic-messages"
			? isOpenRouterAnthropicBaseUrl(model.baseUrl)
			: isOpenRouterBaseUrl(model.baseUrl) && new URL(model.baseUrl).pathname.replace(/\/+$/, "") === "/api/v1";
	if (!validBaseUrl) {
		if (model.api === "anthropic-messages") {
			throw new Error(`OpenRouter routing requires https://openrouter.ai/api, received ${model.baseUrl}`);
		}
		throw new Error(`OpenRouter routing requires https://openrouter.ai/api/v1, received ${model.baseUrl}`);
	}
	if (!isRecord(payload)) throw new Error("OpenRouter request payload must be an object");
	payload.provider = {
		order: [...routing.order],
		allow_fallbacks: routing.allowFallbacks,
	};
	return payload;
}
