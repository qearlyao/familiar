import type { Model } from "@earendil-works/pi-ai/compat";
import type { OpenRouterRoutingConfig } from "../config/index.js";
import { addOpenRouterRouting } from "../models/openrouter-routing.js";
import { isRecord } from "../util/guards.js";

// a mid-conversation system note is only accepted directly after a user turn, and never behind
// another note, so a run of notes folds into one message. A note that opens a turn (a heartbeat
// or cron injection, which trail the last assistant reply) has no user turn to sit behind, so it
// goes on the wire as user text instead of being rejected.
function settleAnthropicSystemNotes(messages: unknown[]): unknown[] {
	const settled: unknown[] = [];
	let openNote: { role: string; content: unknown[] } | undefined;
	for (const message of messages) {
		const blocks = systemNoteBlocks(message);
		if (!blocks) {
			openNote = undefined;
			settled.push(message);
			continue;
		}
		if (openNote) {
			openNote.content.push(...blocks);
			continue;
		}
		const previous = settled.at(-1);
		openNote = { role: isRecord(previous) && previous.role === "user" ? "system" : "user", content: [...blocks] };
		settled.push(openNote);
	}
	return settled;
}

// the text a note carries, or nothing when the message is not a note
function systemNoteBlocks(message: unknown): unknown[] | undefined {
	if (!isRecord(message) || message.role !== "system") return undefined;
	const content = message.content;
	if (typeof content === "string") return content.trim().length > 0 ? [{ type: "text", text: content }] : undefined;
	if (!Array.isArray(content) || content.length === 0) return undefined;
	return content;
}

// ambient recall trails the request as a note that is gone next turn, and any harness note it
// folded into goes with it; the cache breakpoint pi puts on the last message would then never be
// hit, so it moves back onto the stable message before it.
function moveAnthropicCacheControlBeforeInjectedMemory(messages: unknown[]): void {
	let lastIndex = messages.length - 1;
	while (lastIndex >= 0 && isDirectiveOnly(messages[lastIndex])) lastIndex -= 1;
	const lastMessage = messages[lastIndex];
	const stableMessage = messages[lastIndex - 1];
	if (!isRecord(lastMessage) || !isRecord(stableMessage)) return;
	if (lastMessage.role !== "system" && lastMessage.role !== "user") return;
	const content = lastMessage.content;
	if (!Array.isArray(content)) return;
	const injectedBlock = content.at(-1);
	if (!isInjectedMemoryTextBlock(injectedBlock)) return;
	const cacheControl = injectedBlock.cache_control;
	if (!cacheControl) return;
	delete injectedBlock.cache_control;
	if (typeof stableMessage.content === "string") {
		stableMessage.content = [{ type: "text", text: stableMessage.content, cache_control: cacheControl }];
	} else if (Array.isArray(stableMessage.content)) {
		const stableBlock = stableMessage.content.at(-1);
		if (isRecord(stableBlock)) stableBlock.cache_control = cacheControl;
	}
}

// the directive-only form (empty content beside an output_config) is accepted anywhere and carries
// no breakpoint of its own, so the search for the breakpoint's home looks past it
function isDirectiveOnly(message: unknown): boolean {
	return isRecord(message) && message.role === "system" && !systemNoteBlocks(message);
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
	// both passes rewrite the same message list, the second reading what the first settled
	if (model.api === "anthropic-messages" && isRecord(payload) && Array.isArray(payload.messages)) {
		const messages = settleAnthropicSystemNotes(payload.messages);
		payload.messages = messages;
		moveAnthropicCacheControlBeforeInjectedMemory(messages);
	}
	return addOpenRouterRouting(payload, model, routing);
}
