import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { EmbeddingProvider } from "../index/embedding-provider.js";
import type { MemoryIndexStore } from "../index/store.js";
import { retrieveAmbientDiary } from "./ambient.js";

const INJECTED_MEMORY_OPEN = "<injected_memory>";
const INJECTED_MEMORY_CLOSE = "</injected_memory>";

export interface AmbientDiaryInjectorOptions {
	store: MemoryIndexStore;
	embeddingProvider: EmbeddingProvider;
	topK?: number;
	minQueryLength?: number;
	throttleSeconds?: number;
	weightSimilarity?: number;
	weightValence?: number;
	weightRecency?: number;
	weightIntensity?: number;
	now?: () => number;
}

export class AmbientDiaryInjector {
	private readonly store: MemoryIndexStore;
	private readonly embeddingProvider: EmbeddingProvider;
	private readonly topK: number;
	private readonly minQueryLength: number;
	private readonly throttleMs: number;
	private readonly weightSimilarity: number;
	private readonly weightValence: number;
	private readonly weightRecency: number;
	private readonly weightIntensity: number;
	private readonly now: () => number;
	private readonly lastInjectedAtBySession = new Map<string, number>();

	constructor(options: AmbientDiaryInjectorOptions) {
		this.store = options.store;
		this.embeddingProvider = options.embeddingProvider;
		this.topK = positiveIntegerOrDefault(options.topK, 3);
		this.minQueryLength = nonNegativeIntegerOrDefault(options.minQueryLength, 8);
		this.throttleMs = nonNegativeIntegerOrDefault(options.throttleSeconds, 30) * 1000;
		this.weightSimilarity = nonNegativeNumberOrDefault(options.weightSimilarity, 1.0);
		this.weightValence = nonNegativeNumberOrDefault(options.weightValence, 0.08);
		this.weightRecency = nonNegativeNumberOrDefault(options.weightRecency, 0.08);
		this.weightIntensity = nonNegativeNumberOrDefault(options.weightIntensity, 0.1);
		this.now = options.now ?? Date.now;
	}

	async inject(messages: AgentMessage[], signal?: AbortSignal, sessionKey = "default"): Promise<AgentMessage[]> {
		try {
			const query = lastUserText(messages);
			if (!query || query.length < this.minQueryLength) return messages;
			const now = this.now();
			const lastInjectedAt = this.lastInjectedAtBySession.get(sessionKey);
			if (lastInjectedAt !== undefined && this.throttleMs > 0 && now - lastInjectedAt < this.throttleMs)
				return messages;
			const hits = await retrieveAmbientDiary({
				query,
				store: this.store,
				embeddingProvider: this.embeddingProvider,
				limit: this.topK,
				weights: {
					similarity: this.weightSimilarity,
					valence: this.weightValence,
					recency: this.weightRecency,
					intensity: this.weightIntensity,
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

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
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
	if (typeof message.content === "string") return message.content.trim();
	return message.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
}

function renderAmbientDiaryRecall(hits: Awaited<ReturnType<typeof retrieveAmbientDiary>>): string {
	const lines = [INJECTED_MEMORY_OPEN];
	for (const [index, hit] of hits.entries()) {
		const date = typeof hit.chunk.metadata?.date === "string" ? hit.chunk.metadata.date : undefined;
		const heading = typeof hit.chunk.metadata?.heading === "string" ? hit.chunk.metadata.heading : undefined;
		const label = [date, heading].filter(Boolean).join(" ");
		const prefix = label ? `${index + 1}. ${label}` : `${index + 1}. diary`;
		lines.push(`${escapeXmlText(prefix)}: ${escapeXmlText(hit.chunk.snippet || hit.chunk.text)}`);
	}
	lines.push(INJECTED_MEMORY_CLOSE);
	return lines.join("\n");
}

function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export const __ambientDiaryInjectorTest = {
	injectAmbientDiaryRecall,
	lastUserText,
	renderAmbientDiaryRecall,
};
