import type { Model } from "@earendil-works/pi-ai/compat";
import type { OpenRouterRoutingConfig } from "../config/index.js";
import { addOpenRouterRouting } from "../models/openrouter-routing.js";
import { isRecord } from "../util/guards.js";

// TODO: remove once pi-ai handles store:false reasoning replay upstream.
function stripOpenAIStoredReasoningItems(payload: unknown, model: Model<any>): unknown {
	if (model.api !== "openai-responses" && model.api !== "azure-openai-responses") return payload;
	const nextPayload = structuredClone(payload);
	if (!isRecord(nextPayload)) return nextPayload;
	const request = nextPayload as { input?: unknown; store?: unknown };
	if (request.store !== false) return nextPayload;
	const input = request.input;
	if (!Array.isArray(input)) return nextPayload;
	request.input = input.filter((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return true;
		return (item as { type?: unknown }).type !== "reasoning";
	});
	return nextPayload;
}

function moveAnthropicCacheControlBeforeInjectedMemory(payload: unknown, model: Model<any>): unknown {
	if (model.api !== "anthropic-messages") return payload;
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
	const messages = payload.messages;
	const lastMessage = messages.at(-1);
	if (!isRecord(lastMessage) || lastMessage.role !== "user") return payload;
	const content = lastMessage.content;
	if (!Array.isArray(content) || content.length < 2) return payload;
	const injectedBlock = content.at(-1);
	const stableBlock = content.at(-2);
	if (!isInjectedMemoryTextBlock(injectedBlock) || !isRecord(stableBlock)) return payload;
	const cacheControl = injectedBlock.cache_control;
	if (!cacheControl) return payload;
	delete injectedBlock.cache_control;
	stableBlock.cache_control = cacheControl;
	return payload;
}

function isInjectedMemoryTextBlock(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value) || value.type !== "text" || typeof value.text !== "string") return false;
	return value.text.trim().startsWith("<injected_memory>");
}

export function normalizeProviderPayload(
	payload: unknown,
	model: Model<any>,
	routing?: OpenRouterRoutingConfig,
): unknown {
	return addOpenRouterRouting(
		moveAnthropicCacheControlBeforeInjectedMemory(stripOpenAIStoredReasoningItems(payload, model), model),
		model,
		routing,
	);
}
