import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EmbeddingProvider } from "../index/embedding-provider.js";
import type { MemoryIndexStore } from "../index/store.js";
import { positiveIntegerOrDefault } from "../util.js";
import { retrieveAmbientDiary } from "./ambient.js";

const INJECTED_MEMORY_OPEN = "<injected_memory>";
const INJECTED_MEMORY_CLOSE = "</injected_memory>";
const INJECTED_MEMORY_BLOCK_RE = /<injected_memory\b[^>]*>[\s\S]*?<\/injected_memory>/gi;

export interface AmbientDiarySettings {
	enabled?: boolean;
	topK?: number;
	minQueryLength?: number;
	throttleSeconds?: number;
	weightSimilarity?: number;
	weightValence?: number;
	weightRecency?: number;
	weightIntensity?: number;
}

export interface AmbientDiaryInjectorOptions {
	store: MemoryIndexStore;
	embeddingProvider: EmbeddingProvider;
	// Held by reference and read at inject() time, so in-place config mutations apply live.
	settings?: AmbientDiarySettings;
	now?: () => number;
}

export class AmbientDiaryInjector {
	private readonly store: MemoryIndexStore;
	private readonly embeddingProvider: EmbeddingProvider;
	private readonly settings: AmbientDiarySettings;
	private readonly now: () => number;
	private readonly lastInjectedAtBySession = new Map<string, number>();

	constructor(options: AmbientDiaryInjectorOptions) {
		this.store = options.store;
		this.embeddingProvider = options.embeddingProvider;
		this.settings = options.settings ?? {};
		this.now = options.now ?? Date.now;
	}

	async inject(messages: AgentMessage[], signal?: AbortSignal, sessionKey = "default"): Promise<AgentMessage[]> {
		if (!(this.settings.enabled ?? true)) return messages;
		try {
			const query = lastUserText(messages);
			if (!query || query.length < nonNegativeIntegerOrDefault(this.settings.minQueryLength, 8)) return messages;
			const now = this.now();
			const throttleMs = nonNegativeIntegerOrDefault(this.settings.throttleSeconds, 30) * 1000;
			const lastInjectedAt = this.lastInjectedAtBySession.get(sessionKey);
			if (lastInjectedAt !== undefined && throttleMs > 0 && now - lastInjectedAt < throttleMs) return messages;
			debugAmbientQuery(sessionKey, query);
			const hits = await retrieveAmbientDiary({
				query,
				store: this.store,
				embeddingProvider: this.embeddingProvider,
				limit: positiveIntegerOrDefault(this.settings.topK, 3),
				weights: {
					similarity: nonNegativeNumberOrDefault(this.settings.weightSimilarity, 1.0),
					valence: nonNegativeNumberOrDefault(this.settings.weightValence, 0.08),
					recency: nonNegativeNumberOrDefault(this.settings.weightRecency, 0.08),
					intensity: nonNegativeNumberOrDefault(this.settings.weightIntensity, 0.1),
				},
				signal,
			});
			if (hits.length === 0) return messages;
			this.lastInjectedAtBySession.set(sessionKey, now);
			return injectAmbientDiaryRecall(messages, renderAmbientDiaryRecall(hits));
		} catch (error) {
			console.error("memory ambient recall failed", error);
			return messages;
		}
	}
}

function nonNegativeIntegerOrDefault(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function nonNegativeNumberOrDefault(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function injectAmbientDiaryRecall(messages: AgentMessage[], recallText: string): AgentMessage[] {
	const lastUserIndex = findLastUserMessageIndex(messages);
	if (lastUserIndex < 0) return messages;
	return messages.map((message, index) =>
		index === lastUserIndex ? appendTextToUserMessage(message, `\n\n${recallText}`) : message,
	);
}

function appendTextToUserMessage(message: AgentMessage, text: string): AgentMessage {
	if (message.role !== "user") return message;
	if (typeof message.content === "string") return { ...message, content: `${message.content}${text}` };
	return {
		...message,
		content: [...message.content, { type: "text", text }],
	};
}

function findLastUserMessageIndex(messages: readonly AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") return index;
	}
	return -1;
}

function lastUserText(messages: readonly AgentMessage[]): string {
	const index = findLastUserMessageIndex(messages);
	if (index < 0) return "";
	const message = messages[index];
	if (!message || message.role !== "user") return "";
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter(isTextPart)
					.map((item) => item.text)
					.join("\n");
	return stripInjectedMemoryBlocks(text).trim();
}

function isTextPart(item: { type: string; text?: unknown }): item is { type: "text"; text: string } {
	return item.type === "text" && typeof item.text === "string";
}

function stripInjectedMemoryBlocks(text: string): string {
	return text.replace(INJECTED_MEMORY_BLOCK_RE, "").trim();
}

function debugAmbientQuery(sessionKey: string, query: string): void {
	if (
		!process.env.DEBUG?.split(",")
			.map((part) => part.trim())
			.includes("memory-ambient")
	)
		return;
	console.error(JSON.stringify({ event: "ambient_diary_query", sessionKey, query }));
}

function renderAmbientDiaryRecall(hits: Awaited<ReturnType<typeof retrieveAmbientDiary>>): string {
	const lines = [INJECTED_MEMORY_OPEN];
	for (const [index, hit] of hits.entries()) {
		const date = typeof hit.chunk.metadata?.date === "string" ? hit.chunk.metadata.date : undefined;
		const heading = typeof hit.chunk.metadata?.heading === "string" ? hit.chunk.metadata.heading : undefined;
		const rawLabel = [date, heading].filter(Boolean).join(" ");
		const label = diaryLabel(date, heading);
		const prefix = label ? `${index + 1}. ${label}` : `${index + 1}. diary`;
		const text = stripRepeatedDiaryPrefix(hit.chunk.snippet || hit.chunk.text, [rawLabel, label]);
		lines.push(`${escapeXmlText(prefix)}: ${escapeXmlText(text)}`);
	}
	lines.push(INJECTED_MEMORY_CLOSE);
	return lines.join("\n");
}

function diaryLabel(date?: string, heading?: string): string {
	return uniqueNonEmptyStrings([date, heading]).join(" ");
}

function stripRepeatedDiaryPrefix(text: string, labels: readonly string[]): string {
	let trimmed = text.trim();
	for (const label of uniqueNonEmptyStrings(labels)) {
		const escaped = escapeRegExp(label);
		trimmed = trimmed.replace(new RegExp(`^(?:${escaped}\\s*:\\s*)+`, "i"), "").trim();
	}
	return trimmed;
}

function uniqueNonEmptyStrings(values: readonly (string | undefined)[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = value?.trim();
		if (!normalized) continue;
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(normalized);
	}
	return out;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const __ambientDiaryInjectorTest = {
	injectAmbientDiaryRecall,
	lastUserText,
	renderAmbientDiaryRecall,
	diaryLabel,
	stripInjectedMemoryBlocks,
	stripRepeatedDiaryPrefix,
};
