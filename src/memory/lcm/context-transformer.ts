import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

import type { ChunkIndexer } from "../index/chunk-indexer.js";
import {
	createRawContextItems,
	estimateAgentMessageTokens,
	type LcmContextRawItem,
	selectLcmCompactionCandidate,
} from "./context.js";
import { indexLcmSummaries } from "./indexer.js";
import type { LcmSegmentManager } from "./segment-manager.js";
import type { LcmStore } from "./store.js";
import { createSyntheticLcmSummaryMessage, type LcmSummarizer } from "./summarizer.js";
import type { LcmRecordInput } from "./types.js";

const LCM_SUMMARY_PREFIX = "[Familiar retained LCM summary]";

export interface LcmContextTransformOptions {
	sessionKey?: string;
	sessionId?: string;
	model?: Model<any>;
}

export interface LcmContextTransformerOptions {
	settings: {
		enabled: boolean;
		contextThreshold: number;
		freshTailCount: number;
		freshTailMaxTokens?: number;
		leafChunkTokens: number;
		leafTargetTokens: number;
		maxRounds: number;
	};
	lcmStore: LcmStore;
	indexer: ChunkIndexer;
	summarizer: LcmSummarizer;
	segmentManager: LcmSegmentManager;
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
	recordId: number | null;
}

type LcmContextItem = RawLcmItem | CompactedLcmItem;

interface LcmContextState {
	items: LcmContextItem[];
	summaryCounter: number;
	compactionQueue: Promise<void>;
}

export class LcmContextTransformer {
	private readonly settings: LcmContextTransformerOptions["settings"];
	private readonly lcmStore: LcmStore;
	private readonly indexer: ChunkIndexer;
	private readonly summarizer: LcmSummarizer;
	private readonly segmentManager: LcmSegmentManager;
	private readonly contextStates = new Map<string, LcmContextState>();

	constructor(options: LcmContextTransformerOptions) {
		this.settings = options.settings;
		this.lcmStore = options.lcmStore;
		this.indexer = options.indexer;
		this.summarizer = options.summarizer;
		this.segmentManager = options.segmentManager;
	}

	async transformLcmContext(
		messages: AgentMessage[],
		signal: AbortSignal | undefined,
		options: LcmContextTransformOptions,
	): Promise<AgentMessage[]> {
		const settings = this.settings;
		if (!settings.enabled) return messages;
		const sessionKey = options.sessionKey ?? options.sessionId ?? "default";
		const state = this.contextState(sessionKey);
		syncContextState(state, messages);
		this.projectContextState(sessionKey, options.sessionId, state);

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
					targetTokens: this.settings.leafTargetTokens,
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
		const segmentId = this.segmentManager.activeSegmentId(input.sessionKey);
		const recordIds = input.sourceItems.map((item) => item.recordId).filter((id): id is number => id !== null);
		if (recordIds.length === 0) return;
		const summaryId = this.lcmStore.insertSummary({
			segmentId,
			depth: 1,
			status: "ready",
			text: input.text,
			coversFromRecordId: recordIds[0] as number,
			coversToRecordId: recordIds[recordIds.length - 1] as number,
			source: { sourceType: "manual", sourceRef: `lcm_record:${recordIds[0]}-${recordIds[recordIds.length - 1]}` },
			sourceItems: input.sourceItems.map((item) => ({
				recordId: item.recordId,
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

	private projectContextState(sessionKey: string, sessionId: string | undefined, state: LcmContextState): void {
		const segmentId = this.segmentManager.activeSegmentId(sessionKey);
		const inserts = state.items
			.filter((item): item is RawLcmItem => item.type === "raw" && item.recordId === null)
			.map((item) => ({ item, input: rawItemToRecordInput(item, segmentId, sessionKey, sessionId) }));
		if (inserts.length === 0) return;
		this.lcmStore.db
			.transaction(() => {
				for (const insert of inserts) insert.item.recordId = this.lcmStore.insertRecord(insert.input);
			})
			.immediate();
	}
}

function syncContextState(state: LcmContextState, messages: AgentMessage[]): void {
	const existingRecords = new Map(
		state.items.filter((item): item is RawLcmItem => item.type === "raw").map((item) => [item.id, item.recordId]),
	);
	const rawItems = createRawContextItems(messages).map(
		(item): RawLcmItem => ({ ...item, type: "raw", recordId: existingRecords.get(item.id) ?? null }),
	);
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

function rawItemToRecordInput(
	item: RawLcmItem,
	segmentId: string,
	sessionKey: string,
	sessionId: string | undefined,
): LcmRecordInput {
	const role = (item.message as { role?: string }).role;
	const text = extractTextFromMessage(item.message).trim() || `[${role ?? "message"}]`;
	const timestamp = (item.message as { timestamp?: number }).timestamp;
	return {
		segmentId,
		kind: role === "assistant" ? "assistant" : role === "user" ? "user" : "note",
		text,
		happenedAt:
			typeof timestamp === "number" && Number.isFinite(timestamp)
				? new Date(timestamp).toISOString()
				: new Date().toISOString(),
		sessionId: sessionId ?? null,
		channelKey: sessionKey,
		source: { sourceType: "manual", sourceRef: `runtime:${item.id}` },
		metadata: { source: "transformContext", fingerprint: item.id },
	};
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
