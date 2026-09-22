import type { Model } from "@earendil-works/pi-ai/compat";
import type { OpenRouterRoutingConfig } from "../config/index.js";
import { addOpenRouterRouting } from "../models/openrouter-routing.js";
import { isRecord } from "../util/guards.js";

// a mid-conversation system note is only accepted directly after a user turn, and never behind
// another note, so a run of notes folds into one message. A note that opens a turn (a heartbeat
// or cron injection, which trail the last assistant reply) has no user turn to sit behind, so it
// goes on the wire as user text instead of being rejected.
function settleAnthropicSystemNotes(payload: unknown, model: Model<any>): unknown {
	if (model.api !== "anthropic-messages") return payload;
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
	const messages = payload.messages;
	for (let index = 0; index < messages.length; index += 1) {
		const blocks = systemNoteBlocks(messages[index]);
		if (!blocks) continue;
		const merged = [...blocks];
		let end = index + 1;
		for (let next = systemNoteBlocks(messages[end]); next; next = systemNoteBlocks(messages[end])) {
			merged.push(...next);
			end += 1;
		}
		const previous = messages[index - 1];
		const role = isRecord(previous) && previous.role === "user" ? "system" : "user";
		messages.splice(index, end - index, { role, content: merged });
	}
	return payload;
}

// the text a note carries; the directive-only form (empty content beside an output_config) is
// accepted anywhere, so it stays put and is skipped over when placing the cache breakpoint.
function systemNoteBlocks(message: unknown): unknown[] | undefined {
	if (!isRecord(message) || message.role !== "system") return undefined;
	const content = message.content;
	if (typeof content === "string") return content.trim().length > 0 ? [{ type: "text", text: content }] : undefined;
	if (!Array.isArray(content) || content.length === 0) return undefined;
	return content;
}

function isDirectiveOnlyMessage(message: unknown): boolean {
	return isRecord(message) && message.role === "system" && !systemNoteBlocks(message);
}

// ambient recall trails the request as a note that is gone next turn, and any harness note it
// folded into goes with it; the cache breakpoint pi puts on the last message would then never be
// hit, so it moves back onto the stable message before it.
function moveAnthropicCacheControlBeforeInjectedMemory(payload: unknown, model: Model<any>): unknown {
	if (model.api !== "anthropic-messages") return payload;
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
	const messages = payload.messages;
	let lastIndex = messages.length - 1;
	while (lastIndex >= 0 && isDirectiveOnlyMessage(messages[lastIndex])) lastIndex -= 1;
	const lastMessage = messages[lastIndex];
	const stableMessage = messages[lastIndex - 1];
	if (!isRecord(lastMessage) || !isRecord(stableMessage)) return payload;
	if (lastMessage.role !== "system" && lastMessage.role !== "user") return payload;
	const content = lastMessage.content;
	if (!Array.isArray(content)) return payload;
	const injectedBlock = content.at(-1);
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
	const settled = settleAnthropicSystemNotes(payload, model);
	return addOpenRouterRouting(moveAnthropicCacheControlBeforeInjectedMemory(settled, model), model, routing);
}
