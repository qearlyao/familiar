import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

import type { ChunkIndexer } from "../index/chunk-indexer.js";
import { condense } from "./condense.js";
import {
	createRawContextItems,
	estimateAgentMessageTokens,
	type LcmContextRawItem,
	lcmRecordToAgentMessage,
	renderLcmRecordPartsForSummary,
	resolveFreshTailStartIndex,
	type selectLcmCompactionCandidate,
	selectLcmCompactionCandidatePromptAware,
} from "./context.js";
import { indexLcmSummaries } from "./indexer.js";
import type { LcmSegmentManager } from "./segment-manager.js";
import type { LcmStore } from "./store.js";
import { createSyntheticLcmSummaryMessage, type LcmSummarizer } from "./summarizer.js";
import type { LcmContextItemInput, LcmRecordInput, LcmRecordPart, StoredLcmSummary } from "./types.js";

const LCM_SUMMARY_OPEN_TAG = "<from_earlier>";
const LCM_SUMMARY_CLOSE_TAG = "</from_earlier>";

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
		condenseGroupSize: number;
		maxSummaryDepth: number;
		maxRounds: number;
		cacheTtlMs: number;
		cacheTouchSlackMs: number;
		criticalOverflowTokens: number;
		promptAwareEvictionEnabled: boolean;
	};
	lcmStore: LcmStore;
	indexer: ChunkIndexer;
	summarizer: LcmSummarizer;
	segmentManager: LcmSegmentManager;
	now?: () => number;
}

interface CompactedLcmItem {
	type: "summary";
	id: string;
	sourceIds: string[];
	persistedSummaryId?: number;
	depth: number;
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
	compactionDebt: number;
	cacheTouchedAt: number | null;
	compactionQueue: Promise<void>;
	rehydrated: boolean;
}

export class LcmContextTransformer {
	private readonly settings: LcmContextTransformerOptions["settings"];
	private readonly lcmStore: LcmStore;
	private readonly indexer: ChunkIndexer;
	private readonly summarizer: LcmSummarizer;
	private readonly segmentManager: LcmSegmentManager;
	private readonly now: () => number;
	private readonly contextStates = new Map<string, LcmContextState>();

	constructor(options: LcmContextTransformerOptions) {
		this.settings = options.settings;
		this.lcmStore = options.lcmStore;
		this.indexer = options.indexer;
		this.summarizer = options.summarizer;
		this.segmentManager = options.segmentManager;
		this.now = options.now ?? Date.now;
	}

	async transformLcmContext(
		messages: AgentMessage[],
		signal: AbortSignal | undefined,
		options: LcmContextTransformOptions,
	): Promise<AgentMessage[]> {
		const settings = this.settings;
		if (!settings.enabled) return messages;
		const promptText = lastUserText(messages);
		const sessionKey = options.sessionKey ?? options.sessionId ?? "default";
		const state = this.contextState(sessionKey);
		const now = this.now();
		const previousCacheTouchedAt = state.cacheTouchedAt;
		state.cacheTouchedAt = now;
		syncContextState(state, messages);
		this.projectContextState(sessionKey, options.sessionId, state);

		try {
			const pressure = this.evaluateCompactionPressure(state, options.model, promptText);
			state.compactionDebt += pressure.pressureScore;
			if (
				shouldServiceCompactionDebt({
					settings,
					now,
					previousCacheTouchedAt,
					pressureScore: state.compactionDebt,
				})
			) {
				await this.serviceCompactionDebtForState({
					state,
					sessionKey,
					sessionId: options.sessionId,
					signal,
					model: options.model,
					promptText,
				});
			}
		} catch (error) {
			console.error("memory LCM summarization failed", error);
			syncContextState(state, messages);
			this.persistContextState(sessionKey, state);
			this.persistSessionState(sessionKey, state);
			return assembleWithinBudget(state, settings, options.model);
		}

		this.persistContextState(sessionKey, state);
		this.persistSessionState(sessionKey, state);
		return assembleWithinBudget(state, settings, options.model);
	}

	async serviceCompactionDebt(
		sessionKey: string,
		signal?: AbortSignal,
		options: LcmContextTransformOptions = {},
	): Promise<void> {
		const state = this.contextState(sessionKey);
		await this.serviceCompactionDebtForState({
			state,
			sessionKey,
			sessionId: options.sessionId,
			signal,
			model: options.model,
		});
		this.persistContextState(sessionKey, state);
		this.persistSessionState(sessionKey, state);
	}

	private async serviceCompactionDebtForState(input: {
		state: LcmContextState;
		sessionKey: string;
		sessionId?: string;
		signal?: AbortSignal;
		model?: Model<any>;
		promptText?: string;
	}): Promise<void> {
		for (let round = 0; input.state.compactionDebt > 0 && round < this.settings.maxRounds; round += 1) {
			const pressure = this.evaluateCompactionPressure(input.state, input.model, input.promptText ?? "");
			if (!pressure.candidate.shouldCompact) {
				if (pressure.thresholdOverflowTokens > 0) {
					const condensed = await this.condenseRuntimeSummaries({
						state: input.state,
						sessionKey: input.sessionKey,
						signal: input.signal,
					});
					if (condensed.length > 0) {
						input.state.compactionDebt = Math.max(
							0,
							input.state.compactionDebt - pressure.thresholdOverflowTokens,
						);
						continue;
					}
				}
				input.state.compactionDebt = 0;
				break;
			}
			const progress = await this.compactLcmCandidate({
				state: input.state,
				candidate: pressure.candidate,
				sessionKey: input.sessionKey,
				sessionId: input.sessionId,
				signal: input.signal,
			});
			if (!progress.compacted) break;
			input.state.compactionDebt = Math.max(0, input.state.compactionDebt - progress.tokensSaved);
		}
	}

	private evaluateCompactionPressure(
		state: LcmContextState,
		model: Model<any> | undefined,
		promptText = "",
	): {
		candidate: ReturnType<typeof selectLcmCompactionCandidate>;
		pressureScore: number;
		thresholdOverflowTokens: number;
	} {
		const rawItems = state.items.filter((item): item is RawLcmItem => item.type === "raw");
		const summaryTokens = state.items
			.filter((item): item is CompactedLcmItem => item.type === "summary")
			.reduce((total, item) => total + item.tokens, 0);
		const candidate = selectLcmCompactionCandidatePromptAware(
			rawItems,
			{
				contextThreshold: this.settings.contextThreshold,
				freshTailCount: this.settings.freshTailCount,
				freshTailMaxTokens: this.settings.freshTailMaxTokens,
				leafChunkTokens: this.settings.leafChunkTokens,
				promptAwareEvictionEnabled: this.settings.promptAwareEvictionEnabled,
			},
			model?.contextWindow ?? 200_000,
			promptText,
			summaryTokens,
		);
		const evictableTokens = candidate.shouldCompact ? candidate.rawTokensOutsideTail : 0;
		const thresholdOverflowTokens = Math.max(0, candidate.totalTokens - candidate.contextThresholdTokens);
		return {
			candidate,
			pressureScore: Math.max(0, evictableTokens - this.settings.leafTargetTokens, thresholdOverflowTokens),
			thresholdOverflowTokens,
		};
	}

	private async compactLcmCandidate(input: {
		state: LcmContextState;
		candidate: ReturnType<typeof selectLcmCompactionCandidate>;
		sessionKey: string;
		sessionId?: string;
		signal?: AbortSignal;
	}): Promise<{ compacted: boolean; tokensSaved: number }> {
		let compacted = false;
		let tokensSaved = 0;
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
			const message = createSyntheticLcmSummaryMessage(renderLcmSummaryMessage(summaryText), this.now());
			const summaryItem: CompactedLcmItem = {
				type: "summary",
				id: summaryId,
				sourceIds: chunkItems.map((item) => item.id),
				depth: 1,
				message,
				tokens: estimateAgentMessageTokens(message),
			};
			state.items.splice(startIndex, removeCount, summaryItem);
			compacted = true;
			tokensSaved = Math.max(0, candidate.chunkTokens - summaryItem.tokens);
			const persisted = await this.persistRuntimeSummary({
				text: summaryText,
				sourceItems: chunkItems,
				sessionKey: input.sessionKey,
				sessionId: input.sessionId,
				signal: input.signal,
			});
			if (persisted?.summaryId !== undefined) summaryItem.persistedSummaryId = persisted.summaryId;
			await this.condenseRuntimeSummaries({ state, sessionKey: input.sessionKey, signal: input.signal });
		};

		input.state.compactionQueue = input.state.compactionQueue.then(run, run);
		await input.state.compactionQueue;
		return { compacted, tokensSaved };
	}

	private async persistRuntimeSummary(input: {
		text: string;
		sourceItems: RawLcmItem[];
		sessionKey: string;
		sessionId?: string;
		signal?: AbortSignal;
	}): Promise<{ summaryId: number } | null> {
		const segmentId = this.segmentManager.activeSegmentId(input.sessionKey);
		const recordIds = input.sourceItems.map((item) => item.recordId).filter((id): id is number => id !== null);
		if (recordIds.length === 0) return null;
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
				...coverageMetadataFromRawItems(input.sourceItems),
			},
		});
		const summary = this.lcmStore.getSummary(summaryId);
		if (!summary) return null;
		await indexLcmSummaries({ indexer: this.indexer, summaries: [summary] }).catch((error) =>
			console.error("memory LCM summary indexing failed", error),
		);
		return { summaryId };
	}

	private async condenseRuntimeSummaries(input: {
		state: LcmContextState;
		sessionKey: string;
		signal?: AbortSignal;
	}): Promise<StoredLcmSummary[]> {
		const candidateIds = contiguousRuntimeSummaryCandidateIds(input.state.items, 1, this.settings.condenseGroupSize);
		if (candidateIds.length === 0) return [];
		const created = await condense({
			segmentId: this.segmentManager.activeSegmentId(input.sessionKey),
			depth: 1,
			store: this.lcmStore,
			summarizer: this.summarizer,
			config: this.settings,
			candidateIds,
			indexer: this.indexer,
			signal: input.signal,
		});
		applyCondensedRuntimeSummaries(input.state, created, input.sessionKey);
		return created;
	}

	private contextState(sessionKey: string): LcmContextState {
		let state = this.contextStates.get(sessionKey);
		if (!state) {
			state = {
				items: [],
				summaryCounter: 0,
				compactionDebt: 0,
				cacheTouchedAt: null,
				compactionQueue: Promise.resolve(),
				rehydrated: false,
			};
			this.contextStates.set(sessionKey, state);
		}
		if (!state.rehydrated) {
			if (state.items.length === 0) this.rehydrateContextState(sessionKey, state);
			this.rehydrateSessionState(sessionKey, state);
		}
		state.rehydrated = true;
		return state;
	}

	invalidateSession(sessionKey: string): void {
		this.contextStates.delete(sessionKey);
	}

	private projectContextState(sessionKey: string, sessionId: string | undefined, state: LcmContextState): void {
		const segmentId = this.segmentManager.activeSegmentId(sessionKey);
		const inserts = state.items
			.filter((item): item is RawLcmItem => item.type === "raw" && item.recordId === null)
			.map((item) => ({ item, input: rawItemToRecordInput(item, segmentId, sessionKey, sessionId) }));
		if (inserts.length === 0) return;
		this.lcmStore.db
			.transaction(() => {
				for (const insert of inserts) {
					insert.item.recordId = this.lcmStore.insertRecord(insert.input);
					insert.item.record = this.lcmStore.getRecord(insert.item.recordId);
				}
			})
			.immediate();
	}

	private rehydrateContextState(sessionKey: string, state: LcmContextState): void {
		const rows = this.lcmStore.listContextItems(sessionKey);
		if (rows.length === 0) return;
		const items: LcmContextItem[] = [];
		for (const row of rows) {
			if (row.type === "raw") {
				const record = this.lcmStore.getRecord(row.recordId);
				if (!record) {
					console.error(`memory LCM context item dropped because record ${row.recordId} is missing`);
					continue;
				}
				const message = lcmRecordToAgentMessage(record);
				items.push({
					type: "raw",
					id: row.fingerprint,
					recordId: record.id,
					record,
					message,
					tokens: estimateAgentMessageTokens(message),
				});
				continue;
			}
			const summary = this.lcmStore.getSummary(row.summaryId);
			if (!summary) {
				console.error(`memory LCM context item dropped because summary ${row.summaryId} is missing`);
				continue;
			}
			items.push(
				summaryToContextItem(summary, row.fingerprint, sessionKey, this.summaryCoveredSourceIds(summary.id)),
			);
		}
		state.items = items;
	}

	private persistContextState(sessionKey: string, state: LcmContextState): void {
		const items = contextItemsForStorage(state.items);
		this.lcmStore.replaceContextItems(sessionKey, items);
	}

	private rehydrateSessionState(sessionKey: string, state: LcmContextState): void {
		const persisted = this.lcmStore.getSessionState(sessionKey);
		if (!persisted) return;
		state.compactionDebt = persisted.compactionDebt;
		state.cacheTouchedAt = persisted.cacheTouchedAt;
	}

	private persistSessionState(sessionKey: string, state: LcmContextState): void {
		this.lcmStore.upsertSessionState({
			sessionKey,
			compactionDebt: state.compactionDebt,
			cacheTouchedAt: state.cacheTouchedAt,
			updatedAt: this.now(),
		});
	}

	private summaryCoveredSourceIds(summaryId: number, seen = new Set<number>()): string[] {
		if (seen.has(summaryId)) return [];
		seen.add(summaryId);
		const parents = this.lcmStore.getSummaryParents(summaryId);
		if (parents.length > 0) {
			// Condensed summaries use canonical parent edges; source rows are legacy advisory lineage.
			return parents.flatMap((parentId) => this.summaryCoveredSourceIds(parentId, seen));
		}

		const ids: string[] = [];
		for (const source of this.lcmStore.getSummarySources(summaryId)) {
			if (source.sourceSummaryId !== null) {
				ids.push(...this.summaryCoveredSourceIds(source.sourceSummaryId, seen));
			} else if (source.sourceRef) {
				ids.push(source.sourceRef);
			}
		}
		return ids;
	}
}

function syncContextState(state: LcmContextState, messages: AgentMessage[]): void {
	const existingRecords = new Map(
		state.items.filter((item): item is RawLcmItem => item.type === "raw").map((item) => [item.id, item]),
	);
	const rawItems = createRawContextItems(messages).map((item): RawLcmItem => {
		const existing = existingRecords.get(item.id);
		return { ...item, type: "raw", recordId: existing?.recordId ?? null, record: existing?.record ?? null };
	});
	const rawById = new Map(rawItems.map((item) => [item.id, item]));
	const next: LcmContextItem[] = [];
	const covered = new Set<string>();

	for (const item of state.items) {
		if (item.type === "summary") {
			next.push(item);
			for (const id of item.sourceIds) covered.add(id);
			continue;
		}
		const replacement = rawById.get(item.id);
		if (replacement && !covered.has(item.id)) next.push(replacement);
		else if (item.recordId !== null && !covered.has(item.id)) next.push(item);
	}

	for (const item of rawItems) {
		if (!covered.has(item.id) && !next.some((existing) => existing.type === "raw" && existing.id === item.id)) {
			next.push(item);
		}
	}

	state.items = next;
}

function lastUserText(messages: readonly AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || message.role !== "user") continue;
		if (typeof message.content === "string") return message.content.trim();
		return message.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
	}
	return "";
}

function contextItemsForStorage(items: readonly LcmContextItem[]): LcmContextItemInput[] {
	const stored: LcmContextItemInput[] = [];
	for (const item of items) {
		const timestamp = (item.message as { timestamp?: number }).timestamp;
		const happenedAt =
			typeof timestamp === "number" && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
		if (item.type === "raw") {
			if (item.recordId !== null)
				stored.push({ type: "raw", recordId: item.recordId, fingerprint: item.id, happenedAt });
			continue;
		}
		if (item.persistedSummaryId !== undefined) {
			stored.push({ type: "summary", summaryId: item.persistedSummaryId, fingerprint: item.id, happenedAt });
		}
	}
	return stored;
}

function rawItemToRecordInput(
	item: RawLcmItem,
	segmentId: string,
	sessionKey: string,
	sessionId: string | undefined,
): LcmRecordInput {
	const role = (item.message as { role?: string }).role;
	const parts = lcmRecordPartsFromAgentMessage(item.message);
	const text = renderPartsAsPlainText(parts).trim() || `[${role ?? "message"}]`;
	const timestamp = (item.message as { timestamp?: number }).timestamp;
	return {
		segmentId,
		kind: role === "assistant" ? "assistant" : role === "user" ? "user" : role === "toolResult" ? "tool" : "note",
		text,
		parts: parts.length ? parts : undefined,
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

function coverageMetadataFromRawItems(items: readonly RawLcmItem[]): Record<string, string> {
	const happenedAts = items
		.map((item) => item.record?.happenedAt)
		.filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
	const from = happenedAts[0];
	const to = happenedAts.at(-1);
	return {
		...(from ? { coverageFromHappenedAt: from } : {}),
		...(to ? { coverageToHappenedAt: to, timestamp: to } : {}),
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

function replaceCondensedRuntimeSummary(state: LcmContextState, condensed: StoredLcmSummary, sessionKey: string): void {
	const parentIndexes = state.items
		.map((item, index) => ({ item, index }))
		.filter(
			(entry): entry is { item: CompactedLcmItem; index: number } =>
				entry.item.type === "summary" &&
				entry.item.persistedSummaryId !== undefined &&
				condensed.parents.includes(entry.item.persistedSummaryId),
		);
	if (parentIndexes.length !== condensed.parents.length) return;
	const indexes = parentIndexes.map((entry) => entry.index).sort((a, b) => a - b);
	if (!indexes.every((index, offset) => offset === 0 || index === indexes[offset - 1]! + 1)) return;
	const first = indexes[0];
	if (first === undefined) return;
	const sourceIds = parentIndexes.flatMap((entry) => entry.item.sourceIds);
	const message = createSyntheticLcmSummaryMessage(renderLcmSummaryMessage(condensed.text), Date.now());
	const item: CompactedLcmItem = {
		type: "summary",
		id: `${sessionKey}:summary-${condensed.id}`,
		persistedSummaryId: condensed.id,
		depth: condensed.depth,
		sourceIds,
		message,
		tokens: estimateAgentMessageTokens(message),
	};
	state.items.splice(first, indexes.length, item);
}

function applyCondensedRuntimeSummaries(
	state: LcmContextState,
	created: readonly StoredLcmSummary[],
	sessionKey: string,
): void {
	for (const summary of [...created].sort((a, b) => a.depth - b.depth || a.id - b.id)) {
		replaceCondensedRuntimeSummary(state, summary, sessionKey);
	}
}

function contiguousRuntimeSummaryCandidateIds(
	items: readonly LcmContextItem[],
	depth: number,
	groupSize: number,
): number[] {
	const ids: number[] = [];
	for (let index = 0; index < items.length; index += 1) {
		const group = items.slice(index, index + groupSize);
		if (
			group.length === groupSize &&
			group.every(
				(item): item is CompactedLcmItem & { persistedSummaryId: number } =>
					item.type === "summary" && item.depth === depth && item.persistedSummaryId !== undefined,
			)
		) {
			ids.push(...group.map((item) => item.persistedSummaryId));
		}
	}
	return ids;
}

function summaryToContextItem(
	summary: StoredLcmSummary,
	fingerprint: string,
	sessionKey: string,
	sourceIds: string[],
): CompactedLcmItem {
	const message = createSyntheticLcmSummaryMessage(renderLcmSummaryMessage(summary.text), summary.createdAt * 1000);
	return {
		type: "summary",
		id: fingerprint || `${sessionKey}:summary-${summary.id}`,
		persistedSummaryId: summary.id,
		depth: summary.depth,
		sourceIds,
		message,
		tokens: estimateAgentMessageTokens(message),
	};
}

function shouldServiceCompactionDebt(input: {
	settings: LcmContextTransformerOptions["settings"];
	now: number;
	previousCacheTouchedAt: number | null;
	pressureScore: number;
}): boolean {
	if (input.previousCacheTouchedAt === null) return true;
	if (input.pressureScore >= input.settings.criticalOverflowTokens) return true;
	const coldBoundaryMs = Math.max(0, input.settings.cacheTtlMs - input.settings.cacheTouchSlackMs);
	const cacheAgeMs = input.now - input.previousCacheTouchedAt;
	if (cacheAgeMs >= coldBoundaryMs) return true;
	return false;
}

function assembleWithinBudget(
	state: LcmContextState,
	settings: LcmContextTransformerOptions["settings"],
	model: Model<any> | undefined,
): AgentMessage[] {
	const budget = Math.max(1, Math.floor((model?.contextWindow ?? 200_000) * settings.contextThreshold));
	if (sumItemTokens(state.items) <= budget) return state.items.map((item) => item.message);

	const freshTail = state.items.slice(resolveFreshTailStartIndexForState(state.items, settings));
	const selected = new Set<LcmContextItem>(freshTail);
	let tokens = sumItemTokens(freshTail);

	const summaries = state.items
		.filter((item): item is CompactedLcmItem => item.type === "summary" && !selected.has(item))
		.sort((a, b) => b.depth - a.depth || state.items.indexOf(b) - state.items.indexOf(a));
	for (const item of summaries) {
		if (tokens + item.tokens > budget && selected.size > 0) continue;
		selected.add(item);
		tokens += item.tokens;
	}

	for (let index = state.items.length - 1; index >= 0; index -= 1) {
		const item = state.items[index];
		if (!item || selected.has(item) || item.type !== "raw") continue;
		if (tokens + item.tokens > budget && selected.size > 0) continue;
		selected.add(item);
		tokens += item.tokens;
	}

	return state.items.filter((item) => selected.has(item)).map((item) => item.message);
}

function resolveFreshTailStartIndexForState(
	items: readonly LcmContextItem[],
	settings: Pick<LcmContextTransformerOptions["settings"], "freshTailCount" | "freshTailMaxTokens">,
): number {
	return resolveFreshTailStartIndex(items, settings);
}

function sumItemTokens(items: readonly LcmContextItem[]): number {
	return items.reduce((total, item) => total + item.tokens, 0);
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
	return `${LCM_SUMMARY_OPEN_TAG}\n${text.trim()}\n${LCM_SUMMARY_CLOSE_TAG}`;
}

function extractTextFromMessage(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = lcmRecordPartsFromAgentMessage(message);
	return parts.length ? renderLcmRecordPartsForSummary(parts) : renderUnknownContent(content);
}

function lcmRecordPartsFromAgentMessage(message: AgentMessage): LcmRecordPart[] {
	if (!("content" in message)) return [];
	if ((message as { role?: string }).role === "toolResult") {
		const toolResult = message as {
			toolCallId?: string;
			toolName?: string;
			content?: unknown;
			details?: unknown;
			isError?: boolean;
		};
		return [
			{
				kind: "tool_result",
				toolCallId: toolResult.toolCallId ?? "",
				toolName: toolResult.toolName ?? "tool",
				output: toolResult.details ?? textFromContent(toolResult.content),
				...(toolResult.isError ? { isError: true } : {}),
			},
		];
	}
	const content = message.content;
	if (typeof content === "string") return content ? [{ kind: "text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	const parts: LcmRecordPart[] = [];
	for (const item of content) {
		if (item.type === "text") {
			parts.push({
				kind: "text",
				text: item.text,
				...(item.textSignature ? { signature: item.textSignature } : {}),
			});
		}
		else if (item.type === "thinking") {
			parts.push({
				kind: "thinking",
				text: item.thinking,
				...(item.thinkingSignature ? { signature: item.thinkingSignature } : {}),
			});
		} else if (item.type === "toolCall") {
			parts.push({
				kind: "tool_call",
				toolCallId: item.id,
				toolName: item.name,
				arguments: item.arguments,
				...(item.thoughtSignature ? { signature: item.thoughtSignature } : {}),
			});
		} else if (item.type === "image") {
			parts.push({ kind: "text", text: `[image: ${item.mimeType}]` });
		}
	}
	return parts;
}

function renderPartsAsPlainText(parts: readonly LcmRecordPart[]): string {
	return parts
		.map((part) => {
			if (part.kind === "text") return part.text;
			if (part.kind === "thinking") return part.text ? `[thinking] ${part.text}` : "";
			if (part.kind === "tool_call") return `[tool_call: ${part.toolName}(${JSON.stringify(part.arguments)})]`;
			return `[tool_result: ${part.toolName} -> ${stringifyUnknown(part.output)}]`;
		})
		.filter(Boolean)
		.join("\n");
}

function renderUnknownContent(content: unknown[]): string {
	return content
		.map((item) => (item && typeof item === "object" && "type" in item ? `[${String(item.type)}]` : ""))
		.filter(Boolean)
		.join("\n");
}

function textFromContent(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content
		.map((item) => {
			if (item && typeof item === "object" && (item as { type?: unknown }).type === "text") {
				return (item as { text?: unknown }).text;
			}
			return "";
		})
		.filter((item): item is string => typeof item === "string" && item.length > 0)
		.join("\n");
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
