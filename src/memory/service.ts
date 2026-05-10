import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { ChatLogRecord } from "../chat-log.js";
import type { Config } from "../config.js";
import type { ConversationRuntime } from "../runtime.js";
import { retrieveAmbientDiary } from "./diary/ambient.js";
import { indexAllDiaryFiles } from "./diary/indexer.js";
import { ChunkIndexer } from "./index/chunk-indexer.js";
import { createEmbeddingProvider } from "./index/embedding-provider.js";
import { MemoryIndexStore } from "./index/store.js";
import { projectNormalizedLcmBatch } from "./lcm/indexer.js";
import { normalizeChatRecords } from "./lcm/normalize.js";
import { LcmStore } from "./lcm/store.js";

const AMBIENT_CONTEXT_PREFIX = "[Familiar diary recall]";

export interface MemoryService {
	indexDiaries(): Promise<void>;
	subscribeRuntime(runtime: ConversationRuntime, sessionId?: string): () => void;
	transformContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;
	flush(): Promise<void>;
	close(): void;
}

export function createMemoryService(config: Config): MemoryService {
	return new DefaultMemoryService(config);
}

class DefaultMemoryService implements MemoryService {
	private readonly lcmStore: LcmStore;
	private readonly memoryStore: MemoryIndexStore;
	private readonly embeddingProvider;
	private readonly indexer: ChunkIndexer;
	private readonly activeSegments = new Map<string, string>();
	private readonly segmentCounters = new Map<string, number>();
	private projectionQueue = Promise.resolve();

	constructor(private readonly config: Config) {
		this.lcmStore = LcmStore.open(config);
		this.memoryStore = MemoryIndexStore.open(config);
		this.embeddingProvider = createEmbeddingProvider(config);
		this.indexer = new ChunkIndexer({ store: this.memoryStore, embeddingProvider: this.embeddingProvider });
	}

	async indexDiaries(): Promise<void> {
		await indexAllDiaryFiles({ config: this.config, indexer: this.indexer });
	}

	subscribeRuntime(runtime: ConversationRuntime, sessionId?: string): () => void {
		const unsubscribe = runtime.subscribe((record) => {
			this.projectionQueue = this.projectionQueue.then(
				() => this.projectRuntimeRecord(runtime, record, sessionId),
				() => this.projectRuntimeRecord(runtime, record, sessionId),
			);
			void this.projectionQueue.catch((error) =>
				console.error(`memory projection failed for ${runtime.channelKey}`, error),
			);
		});
		return unsubscribe;
	}

	async transformContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
		try {
			const query = lastUserText(messages);
			if (!query) return messages;
			const hits = await retrieveAmbientDiary({
				query,
				store: this.memoryStore,
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

	close(): void {
		this.memoryStore.close();
		this.lcmStore.close();
	}

	async flush(): Promise<void> {
		await this.projectionQueue.catch(() => undefined);
	}

	private async projectRuntimeRecord(
		runtime: ConversationRuntime,
		record: ChatLogRecord,
		sessionId: string | undefined,
	): Promise<void> {
		if (record.type === "runtime" && record.event === "reset") {
			this.rotateRuntimeSegment(runtime, record);
			return;
		}
		const segmentId = this.activeSegmentId(runtime.channelKey);
		const batch = normalizeChatRecords([record], {
			segmentId,
			sessionId: sessionId ?? null,
			channelKey: runtime.channelKey,
		});
		if (batch.records.length === 0 && batch.segments.length === 0) return;
		await projectNormalizedLcmBatch({ batch, lcmStore: this.lcmStore, indexer: this.indexer });
	}

	private rotateRuntimeSegment(
		runtime: ConversationRuntime,
		record: Extract<ChatLogRecord, { type: "runtime" }>,
	): void {
		const previousSegmentId = this.activeSegmentId(runtime.channelKey);
		const batch = normalizeChatRecords([record], {
			segmentId: previousSegmentId,
			channelKey: runtime.channelKey,
		});
		for (const segment of batch.segments) this.lcmStore.ensureSegment(segment);
		for (const normalizedRecord of batch.records) this.lcmStore.insertRecord(normalizedRecord);
		this.lcmStore.closeSegment(previousSegmentId, record.ts);
		const nextSegmentId = this.nextSegmentId(runtime.channelKey);
		this.activeSegments.set(runtime.channelKey, nextSegmentId);
		this.lcmStore.ensureSegment({
			id: nextSegmentId,
			channelKey: runtime.channelKey,
			startedAt: record.ts,
			boundarySource: {
				sourceType: "chat",
				sourceRecordId: record.recordId,
				sourceRef: `chat:${record.recordId}`,
			},
		});
		this.lcmStore.applyNewSessionRetention({
			newSessionRetainDepth: this.config.memory.lcm.newSessionRetainDepth,
			activeSegmentId: nextSegmentId,
		});
	}

	private activeSegmentId(channelKey: string): string {
		const existing = this.activeSegments.get(channelKey);
		if (existing) return existing;
		const next = this.nextSegmentId(channelKey);
		this.activeSegments.set(channelKey, next);
		return next;
	}

	private nextSegmentId(channelKey: string): string {
		const next = (this.segmentCounters.get(channelKey) ?? 0) + 1;
		this.segmentCounters.set(channelKey, next);
		return `${channelKey}:seg-${next}`;
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

export const __memoryServiceTest = {
	injectAmbientDiaryRecall,
	lastUserText,
	renderAmbientDiaryRecall,
};
