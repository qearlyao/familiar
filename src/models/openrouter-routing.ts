import type { Model } from "@earendil-works/pi-ai/compat";
import type { Config, OpenRouterRoutingConfig } from "../config/types.js";
import { isRecord } from "../util/guards.js";

export function isOpenRouterAnthropicBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return (
			url.origin === "https://openrouter.ai" &&
			url.username === "" &&
			url.password === "" &&
			url.pathname.replace(/\/+$/, "") === "/api" &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
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
	if (model.api !== "anthropic-messages") {
		throw new Error(`OpenRouter routing requires anthropic-messages, received ${model.api}`);
	}
	if (!isOpenRouterAnthropicBaseUrl(model.baseUrl)) {
		throw new Error(`OpenRouter routing requires https://openrouter.ai/api, received ${model.baseUrl}`);
	}
	if (!isRecord(payload)) throw new Error("OpenRouter Anthropic request payload must be an object");
	payload.provider = {
		order: [...routing.order],
		allow_fallbacks: routing.allowFallbacks,
	};
	return payload;
}
