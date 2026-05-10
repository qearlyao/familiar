import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

import type { ChatLogRecord } from "../chat-log.js";
import type { Config } from "../config.js";
import type { ConversationRuntime } from "../runtime.js";
import { retrieveAmbientDiary } from "./diary/ambient.js";
import { indexAllDiaryFiles } from "./diary/indexer.js";
import { ChunkIndexer } from "./index/chunk-indexer.js";
import { createEmbeddingProvider } from "./index/embedding-provider.js";
import { MemoryIndexStore } from "./index/store.js";
import {
	createRawContextItems,
	estimateAgentMessageTokens,
	type LcmContextRawItem,
	selectLcmCompactionCandidate,
} from "./lcm/context.js";
import { indexLcmSummaries, projectNormalizedLcmBatch } from "./lcm/indexer.js";
import { normalizeChatRecords } from "./lcm/normalize.js";
import { LcmStore } from "./lcm/store.js";
import { createSyntheticLcmSummaryMessage, DefaultLcmSummarizer, type LcmSummarizer } from "./lcm/summarizer.js";

const AMBIENT_CONTEXT_PREFIX = "[Familiar diary recall]";
const LCM_SUMMARY_PREFIX = "[Familiar retained LCM summary]";

export interface MemoryService {
	indexDiaries(): Promise<void>;
	subscribeRuntime(runtime: ConversationRuntime, sessionId?: string): () => void;
	transformContext(
		messages: AgentMessage[],
		signal?: AbortSignal,
		options?: MemoryTransformOptions,
	): Promise<AgentMessage[]>;
	flush(): Promise<void>;
	close(): void;
}

export interface MemoryTransformOptions {
	sessionKey?: string;
	sessionId?: string;
	model?: Model<any>;
}

export interface MemoryServiceOptions {
	summarizer?: LcmSummarizer;
}

interface CompactedLcmItem {
	type: "summary";
	id: string;
	sourceIds: string[];
	message: AssistantMessage;
	tokens: number;
}

interface RawLcmItem extends LcmContextRawItem {
	type: "raw";
}

type LcmContextItem = RawLcmItem | CompactedLcmItem;

interface LcmContextState {
	items: LcmContextItem[];
	summaryCounter: number;
	compactionQueue: Promise<void>;
}

export function createMemoryService(config: Config, options: MemoryServiceOptions = {}): MemoryService {
	return new DefaultMemoryService(config, options);
}

class DefaultMemoryService implements MemoryService {
	private readonly lcmStore: LcmStore;
	private readonly memoryStore: MemoryIndexStore;
	private readonly embeddingProvider;
	private readonly indexer: ChunkIndexer;
	private readonly summarizer: LcmSummarizer;
	private readonly contextStates = new Map<string, LcmContextState>();
	private readonly activeSegments = new Map<string, string>();
	private readonly segmentCounters = new Map<string, number>();
	private projectionQueue = Promise.resolve();

	constructor(
		private readonly config: Config,
		options: MemoryServiceOptions = {},
	) {
		this.lcmStore = LcmStore.open(config);
		this.memoryStore = MemoryIndexStore.open(config);
		this.embeddingProvider = createEmbeddingProvider(config);
		this.indexer = new ChunkIndexer({ store: this.memoryStore, embeddingProvider: this.embeddingProvider });
		this.summarizer = options.summarizer ?? new DefaultLcmSummarizer(config);
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

	async transformContext(
		messages: AgentMessage[],
		signal?: AbortSignal,
		options: MemoryTransformOptions = {},
	): Promise<AgentMessage[]> {
		const compacted = await this.transformLcmContext(messages, signal, options);
		try {
			const query = lastUserText(compacted);
			if (!query) return compacted;
			const hits = await retrieveAmbientDiary({
				query,
				store: this.memoryStore,
				embeddingProvider: this.embeddingProvider,
				limit: 3,
				signal,
			});
			if (hits.length === 0) return compacted;
			return injectAmbientDiaryRecall(compacted, renderAmbientDiaryRecall(hits));
		} catch (error) {
			console.error("memory ambient recall failed", error);
			return compacted;
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
		const retention = this.lcmStore.applyNewSessionRetention({
			newSessionRetainDepth: this.config.memory.lcm.newSessionRetainDepth,
			activeSegmentId: nextSegmentId,
		});
		for (const deleted of retention.indexDeletes) {
			this.memoryStore.deleteBySource(deleted.corpus, deleted.sourceId);
		}
	}

	private activeSegmentId(channelKey: string): string {
		const existing = this.activeSegments.get(channelKey);
		if (existing) return existing;
		const persisted = this.findPersistedActiveSegmentId(channelKey);
		if (persisted) {
			this.activeSegments.set(channelKey, persisted);
			this.seedSegmentCounter(channelKey);
			return persisted;
		}
		this.seedSegmentCounter(channelKey);
		const next = this.nextSegmentId(channelKey);
		this.activeSegments.set(channelKey, next);
		return next;
	}

	private nextSegmentId(channelKey: string): string {
		const next = (this.segmentCounters.get(channelKey) ?? 0) + 1;
		this.segmentCounters.set(channelKey, next);
		return `${channelKey}:seg-${next}`;
	}

	private findPersistedActiveSegmentId(channelKey: string): string | null {
		const segments = this.lcmStore
			.listSegments()
			.filter((segment) => segment.channelKey === channelKey && segment.status === "active")
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
		return segments[0]?.id ?? null;
	}

	private seedSegmentCounter(channelKey: string): void {
		const existing = this.segmentCounters.get(channelKey) ?? 0;
		let max = existing;
		for (const segment of this.lcmStore.listSegments()) {
			if (segment.channelKey !== channelKey) continue;
			const match = segment.id.match(/:seg-(\d+)$/);
			if (!match) continue;
			max = Math.max(max, Number(match[1]));
		}
		this.segmentCounters.set(channelKey, max);
	}

	private async transformLcmContext(
		messages: AgentMessage[],
		signal: AbortSignal | undefined,
		options: MemoryTransformOptions,
	): Promise<AgentMessage[]> {
		const settings = this.config.memory.lcm;
		if (!settings.enabled) return messages;
		const sessionKey = options.sessionKey ?? options.sessionId ?? "default";
		const state = this.contextState(sessionKey);
		syncContextState(state, messages);

		try {
			for (let round = 0; round < settings.maxRounds; round += 1) {
				const rawItems = state.items.filter((item): item is RawLcmItem => item.type === "raw");
				const summaryTokens = state.items
					.filter((item): item is CompactedLcmItem => item.type === "summary")
					.reduce((total, item) => total + item.tokens, 0);
				const candidate = selectLcmCompactionCandidate(
					rawItems,
					{
						contextThreshold: settings.contextThreshold,
						freshTailCount: settings.freshTailCount,
						freshTailMaxTokens: settings.freshTailMaxTokens,
						leafChunkTokens: settings.leafChunkTokens,
					},
					options.model?.contextWindow ?? 200_000,
					summaryTokens,
				);
				if (!candidate.shouldCompact) break;
				await this.compactLcmCandidate({ state, candidate, sessionKey, sessionId: options.sessionId, signal });
			}
		} catch (error) {
			console.error("memory LCM summarization failed", error);
			syncContextState(state, messages);
			return messages;
		}

		return state.items.map((item) => item.message);
	}

	private async compactLcmCandidate(input: {
		state: LcmContextState;
		candidate: ReturnType<typeof selectLcmCompactionCandidate>;
		sessionKey: string;
		sessionId?: string;
		signal?: AbortSignal;
	}): Promise<void> {
		const run = async () => {
			const { state, candidate } = input;
			const sourceIds = new Set(candidate.chunk.map((item) => item.id));
			const startIndex = state.items.findIndex((item) => item.type === "raw" && sourceIds.has(item.id));
			if (startIndex < 0) return;
			const removeCount = countContiguousRawSources(state.items, startIndex, sourceIds);
			if (removeCount <= 0) return;
			const chunkItems = state.items
				.slice(startIndex, startIndex + removeCount)
				.filter((item): item is RawLcmItem => item.type === "raw");
			if (chunkItems.length === 0) return;
			const previousSummary = findPreviousSummaryText(state.items, startIndex);
			const text = renderLcmSummaryInput(chunkItems);
			const summaryText = await this.summarizer.summarizeLeaf(
				{
					text,
					targetTokens: this.config.memory.lcm.leafTargetTokens,
					mode: candidate.reasons.includes("context_threshold") ? "aggressive" : "normal",
					previousSummary,
				},
				input.signal,
			);
			const summaryId = `${input.sessionKey}:summary-${++state.summaryCounter}`;
			const message = createSyntheticLcmSummaryMessage(renderLcmSummaryMessage(summaryText), Date.now());
			const summaryItem: CompactedLcmItem = {
				type: "summary",
				id: summaryId,
				sourceIds: chunkItems.map((item) => item.id),
				message,
				tokens: estimateAgentMessageTokens(message),
			};
			state.items.splice(startIndex, removeCount, summaryItem);
			await this.persistRuntimeSummary({
				text: summaryText,
				sourceItems: chunkItems,
				sessionKey: input.sessionKey,
				sessionId: input.sessionId,
			});
		};

		input.state.compactionQueue = input.state.compactionQueue.then(run, run);
		await input.state.compactionQueue;
	}

	private async persistRuntimeSummary(input: {
		text: string;
		sourceItems: RawLcmItem[];
		sessionKey: string;
		sessionId?: string;
	}): Promise<void> {
		const segmentId = this.activeSegmentId(input.sessionKey);
		const summaryId = this.lcmStore.insertSummary({
			segmentId,
			depth: 1,
			status: "ready",
			text: input.text,
			source: { sourceType: "manual", sourceRef: `runtime:${input.sessionKey}` },
			sourceItems: input.sourceItems.map((item) => ({
				sourceRef: item.id,
				snapshot: {
					role: (item.message as { role?: string }).role ?? null,
					timestamp: (item.message as { timestamp?: number }).timestamp ?? null,
				},
			})),
			metadata: {
				sessionKey: input.sessionKey,
				sessionId: input.sessionId ?? null,
				source: "transformContext",
			},
		});
		const summary = this.lcmStore.getSummary(summaryId);
		if (!summary) return;
		await indexLcmSummaries({ indexer: this.indexer, summaries: [summary] }).catch((error) =>
			console.error("memory LCM summary indexing failed", error),
		);
	}

	private contextState(sessionKey: string): LcmContextState {
		let state = this.contextStates.get(sessionKey);
		if (!state) {
			state = { items: [], summaryCounter: 0, compactionQueue: Promise.resolve() };
			this.contextStates.set(sessionKey, state);
		}
		return state;
	}
}

function syncContextState(state: LcmContextState, messages: AgentMessage[]): void {
	const rawItems = createRawContextItems(messages).map((item): RawLcmItem => ({ ...item, type: "raw" }));
	const rawById = new Map(rawItems.map((item) => [item.id, item]));
	const next: LcmContextItem[] = [];
	const covered = new Set<string>();

	for (const item of state.items) {
		if (item.type === "summary") {
			const stillCovered = item.sourceIds.every((id) => rawById.has(id));
			if (!stillCovered) continue;
			next.push(item);
			for (const id of item.sourceIds) covered.add(id);
			continue;
		}
		const replacement = rawById.get(item.id);
		if (replacement && !covered.has(item.id)) next.push(replacement);
	}

	for (const item of rawItems) {
		if (!covered.has(item.id) && !next.some((existing) => existing.type === "raw" && existing.id === item.id)) {
			next.push(item);
		}
	}

	state.items = next;
}

function countContiguousRawSources(
	items: readonly LcmContextItem[],
	startIndex: number,
	sourceIds: Set<string>,
): number {
	let count = 0;
	for (let index = startIndex; index < items.length; index += 1) {
		const item = items[index];
		if (!item || item.type !== "raw" || !sourceIds.has(item.id)) break;
		count += 1;
	}
	return count;
}

function findPreviousSummaryText(items: readonly LcmContextItem[], beforeIndex: number): string | undefined {
	for (let index = beforeIndex - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item?.type !== "summary") continue;
		return extractTextFromMessage(item.message);
	}
	return undefined;
}

function renderLcmSummaryInput(items: readonly RawLcmItem[]): string {
	return items
		.map((item) => renderMessageForSummary(item.message))
		.filter(Boolean)
		.join("\n\n");
}

function renderMessageForSummary(message: AgentMessage): string {
	const role = (message as { role?: string }).role ?? "message";
	const timestamp = (message as { timestamp?: number }).timestamp;
	const date = typeof timestamp === "number" && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
	const text = extractTextFromMessage(message).trim();
	if (!text) return "";
	return [`[${role}${date ? ` ${date}` : ""}]`, text].join("\n");
}

function renderLcmSummaryMessage(text: string): string {
	return `${LCM_SUMMARY_PREFIX}\n${text.trim()}`;
}

function extractTextFromMessage(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (item.type === "text") return item.text;
			if (item.type === "thinking") return item.thinking;
			if (item.type === "toolCall") return `[tool call: ${item.name} ${JSON.stringify(item.arguments)}]`;
			if (item.type === "image") return `[image: ${item.mimeType}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
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
