import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { EmbeddingProvider } from "../index/embedding-provider.js";
import type { MemoryIndexStore } from "../index/store.js";
import { retrieveAmbientDiary } from "./ambient.js";

const AMBIENT_CONTEXT_PREFIX = "[Familiar diary recall]";

export interface AmbientDiaryInjectorOptions {
	store: MemoryIndexStore;
	embeddingProvider: EmbeddingProvider;
}

export class AmbientDiaryInjector {
	private readonly store: MemoryIndexStore;
	private readonly embeddingProvider: EmbeddingProvider;

	constructor(options: AmbientDiaryInjectorOptions) {
		this.store = options.store;
		this.embeddingProvider = options.embeddingProvider;
	}

	async inject(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
		try {
			const query = lastUserText(messages);
			if (!query) return messages;
			const hits = await retrieveAmbientDiary({
				query,
				store: this.store,
				embeddingProvider: this.embeddingProvider,
				limit: 3,
				signal,
			});
			if (hits.length === 0) return messages;
			return injectAmbientDiaryRecall(messages, renderAmbientDiaryRecall(hits));
		} catch (error) {
			console.error("memory ambient recall failed", error);
			return messages;
		}
	}
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
	const lines = [AMBIENT_CONTEXT_PREFIX];
	for (const [index, hit] of hits.entries()) {
		const date = typeof hit.chunk.metadata?.date === "string" ? hit.chunk.metadata.date : undefined;
		const heading = typeof hit.chunk.metadata?.heading === "string" ? hit.chunk.metadata.heading : undefined;
		const label = [date, heading].filter(Boolean).join(" ");
		const prefix = label ? `${index + 1}. ${label}` : `${index + 1}. diary`;
		lines.push(`${prefix}: ${hit.chunk.snippet || hit.chunk.text}`);
	}
	return lines.join("\n");
}

export const __ambientDiaryInjectorTest = {
	injectAmbientDiaryRecall,
	lastUserText,
	renderAmbientDiaryRecall,
};
