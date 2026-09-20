import type { Model } from "@earendil-works/pi-ai/compat";
import type { OpenRouterRoutingConfig } from "../config/index.js";
import { addOpenRouterRouting } from "../models/openrouter-routing.js";
import { isRecord } from "../util/guards.js";

// ambient recall trails the request as a system note that is gone next turn; the cache
// breakpoint pi puts on the last message would then never be hit, so it moves back onto
// the stable message before it.
function moveAnthropicCacheControlBeforeInjectedMemory(payload: unknown, model: Model<any>): unknown {
	if (model.api !== "anthropic-messages") return payload;
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
	const messages = payload.messages;
	const lastMessage = messages.at(-1);
	const stableMessage = messages.at(-2);
	if (!isRecord(lastMessage) || !isRecord(stableMessage)) return payload;
	if (lastMessage.role !== "system" && lastMessage.role !== "user") return payload;
	const content = lastMessage.content;
	if (!Array.isArray(content) || content.length !== 1) return payload;
	const injectedBlock = content[0];
	if (!isInjectedMemoryTextBlock(injectedBlock)) return payload;
	const cacheControl = injectedBlock.cache_control;
	if (!cacheControl) return payload;
	delete injectedBlock.cache_control;
	if (typeof stableMessage.content === "string") {
		stableMessage.content = [{ type: "text", text: stableMessage.content, cache_control: cacheControl }];
	} else if (Array.isArray(stableMessage.content)) {
		const stableBlock = stableMessage.content.at(-1);
		if (isRecord(stableBlock)) stableBlock.cache_control = cacheControl;
	}
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
	return addOpenRouterRouting(moveAnthropicCacheControlBeforeInjectedMemory(payload, model), model, routing);
}
