import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

import type { LcmAttachmentNote, LcmRecordKind, StoredLcmRecord, StoredLcmSummary } from "./types.js";

export interface FreshTailOptions {
	messageCount: number;
	maxTokens?: number;
}

export interface FreshTailSelection {
	records: StoredLcmRecord[];
	tokenCount: number;
	overflowTokens: number;
}

export interface LcmCompactionPressureInput {
	records: readonly StoredLcmRecord[];
	summaries?: readonly StoredLcmSummary[];
	freshTail: FreshTailOptions;
	evictableTokenThreshold?: number;
	evictableTokenBudget?: number;
	evictableKinds?: readonly LcmRecordKind[];
}

export interface LcmCompactionPressure {
	shouldCompact: boolean;
	reasons: ("evictable_threshold" | "evictable_budget")[];
	evictableTokens: number;
	evictableRecordCount: number;
	freshTailTokens: number;
	freshTailRecordCount: number;
	summaryTokens: number;
	assembledTokens: number;
	evictableTokenThreshold: number | null;
	evictableTokenBudget: number | null;
}

export interface LcmContextCompactionConfig {
	contextThreshold: number;
	freshTailCount: number;
	freshTailMaxTokens?: number;
	leafChunkTokens: number;
}

export interface LcmCompactionCandidate {
	shouldCompact: boolean;
	reasons: ("leaf_chunk" | "context_threshold")[];
	chunk: LcmContextRawItem[];
	chunkTokens: number;
	rawTokensOutsideTail: number;
	freshTailStartIndex: number;
	totalTokens: number;
	contextThresholdTokens: number;
}

export interface LcmContextRawItem {
	id: string;
	message: AgentMessage;
	tokens: number;
}

type LcmRecordTokenInput = string | Pick<StoredLcmRecord, "kind" | "text" | "attachments">;

const MESSAGE_OVERHEAD_TOKENS = 6;
const RECORD_OVERHEAD_TOKENS = 4;
const IMAGE_TOKEN_ESTIMATE = 1200;
export function estimateTextTokens(text: string): number {
	if (!text) return 0;
	let ascii = 0;
	let nonAscii = 0;
	for (const char of text) {
		const codePoint = char.codePointAt(0) ?? 0;
		if (codePoint <= 0x7f) ascii += 1;
		else nonAscii += 1;
	}
	return Math.ceil(ascii / 3) + nonAscii;
}

export function estimateLcmRecordTokens(recordOrText: LcmRecordTokenInput): number {
	const text = typeof recordOrText === "string" ? recordOrText : recordOrText.text;
	const attachments = typeof recordOrText === "string" ? null : recordOrText.attachments;
	const attachmentText = attachments?.map(renderAttachmentForEstimate).filter(Boolean).join("\n") ?? "";
	const contentTokens = estimateTextTokens([text, attachmentText].filter(Boolean).join("\n"));
	return contentTokens > 0 ? contentTokens + RECORD_OVERHEAD_TOKENS : 0;
}

export function estimateAgentMessageTokens(message: AgentMessage): number {
	const role = (message as { role?: string }).role;
	switch (role) {
		case "user":
			return estimateUserMessageTokens(message as UserMessage);
		case "assistant":
			return estimateAssistantMessageTokens(message as AssistantMessage);
		case "toolResult":
			return estimateToolResultMessageTokens(message as ToolResultMessage);
		default:
			return estimateFallbackMessageTokens(message);
	}
}

export function createAgentMessageFingerprint(message: AgentMessage, _index: number): string {
	const timestamp = (message as { timestamp?: number }).timestamp;
	const id = (message as { id?: string }).id;
	const text = messageTextForFingerprint(message);
	const payload =
		typeof timestamp === "number" && Number.isFinite(timestamp)
			? { role: (message as { role?: string }).role ?? null, timestamp, text }
			: typeof id === "string" && id.trim()
				? { role: (message as { role?: string }).role ?? null, id, text }
				: { text };
	return createHash("sha256")
		.update(JSON.stringify(payload))
		.digest("hex");
}

export function createRawContextItems(messages: readonly AgentMessage[]): LcmContextRawItem[] {
	return messages.map((message, index) => ({
		id: createAgentMessageFingerprint(message, index),
		message,
		tokens: estimateAgentMessageTokens(message),
	}));
}

export function selectLcmCompactionCandidate(
	items: readonly LcmContextRawItem[],
	config: LcmContextCompactionConfig,
	tokenBudget: number,
	additionalContextTokens = 0,
): LcmCompactionCandidate {
	const freshTailStartIndex = resolveFreshTailStartIndex(items, config);
	const compactable = items.slice(0, freshTailStartIndex);
	const rawTokensOutsideTail = compactable.reduce((total, item) => total + item.tokens, 0);
	const totalTokens = items.reduce((total, item) => total + item.tokens, 0) + Math.max(0, additionalContextTokens);
	const contextThresholdTokens = Math.max(1, Math.floor(config.contextThreshold * tokenBudget));
	const reasons: LcmCompactionCandidate["reasons"] = [];
	if (rawTokensOutsideTail >= config.leafChunkTokens) reasons.push("leaf_chunk");
	if (totalTokens > contextThresholdTokens && compactable.length > 0) reasons.push("context_threshold");
	const chunk = reasons.length > 0 ? selectOldestLeafChunk(compactable, config.leafChunkTokens) : [];
	const chunkTokens = chunk.reduce((total, item) => total + item.tokens, 0);

	return {
		shouldCompact: chunk.length > 0,
		reasons,
		chunk,
		chunkTokens,
		rawTokensOutsideTail,
		freshTailStartIndex,
		totalTokens,
		contextThresholdTokens,
	};
}

export function selectFreshTailRecords(
	records: readonly StoredLcmRecord[],
	options: FreshTailOptions,
): FreshTailSelection {
	const messageCount = nonNegativeInteger(options.messageCount, "freshTail.messageCount");
	const maxTokens =
		options.maxTokens === undefined ? undefined : nonNegativeInteger(options.maxTokens, "freshTail.maxTokens");
	const candidates = records.filter(isConversationRecord).sort(compareRecords);
	const selected: StoredLcmRecord[] = [];
	let tokenCount = 0;

	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const record = candidates[index];
		if (!record) continue;
		const recordTokens = estimateLcmRecordTokens(record);
		const protectedByCount = selected.length < messageCount;
		if (!protectedByCount) {
			if (maxTokens === undefined || tokenCount + recordTokens > maxTokens) break;
		}
		selected.push(record);
		tokenCount += recordTokens;
	}

	selected.reverse();
	return {
		records: selected,
		tokenCount,
		overflowTokens: maxTokens === undefined ? 0 : Math.max(0, tokenCount - maxTokens),
	};
}

export function detectLcmCompactionPressure(input: LcmCompactionPressureInput): LcmCompactionPressure {
	const freshTail = selectFreshTailRecords(input.records, input.freshTail);
	const freshTailIds = new Set(freshTail.records.map((record) => record.id));
	const evictableKinds = new Set(
		input.evictableKinds ?? (["user", "assistant", "tool", "note"] satisfies LcmRecordKind[]),
	);
	let evictableTokens = 0;
	let evictableRecordCount = 0;

	for (const record of input.records) {
		if (freshTailIds.has(record.id) || !evictableKinds.has(record.kind)) continue;
		evictableTokens += estimateLcmRecordTokens(record);
		evictableRecordCount += 1;
	}

	const summaryTokens = selectRetainedSummaries(input.summaries ?? []).reduce(
		(total, summary) => total + estimateTextTokens(summary.text) + RECORD_OVERHEAD_TOKENS,
		0,
	);
	const threshold = optionalNonNegativeInteger(input.evictableTokenThreshold, "evictableTokenThreshold");
	const budget = optionalNonNegativeInteger(input.evictableTokenBudget, "evictableTokenBudget");
	const reasons: LcmCompactionPressure["reasons"] = [];
	if (threshold !== null && evictableTokens > threshold) reasons.push("evictable_threshold");
	if (budget !== null && evictableTokens > budget) reasons.push("evictable_budget");

	return {
		shouldCompact: reasons.length > 0,
		reasons,
		evictableTokens,
		evictableRecordCount,
		freshTailTokens: freshTail.tokenCount,
		freshTailRecordCount: freshTail.records.length,
		summaryTokens,
		assembledTokens: summaryTokens + freshTail.tokenCount,
		evictableTokenThreshold: threshold,
		evictableTokenBudget: budget,
	};
}

function estimateUserMessageTokens(message: UserMessage): number {
	return MESSAGE_OVERHEAD_TOKENS + estimateContentTokens(message.content);
}

function estimateAssistantMessageTokens(message: AssistantMessage): number {
	let tokens = MESSAGE_OVERHEAD_TOKENS;
	for (const block of message.content) {
		if (block.type === "text") tokens += estimateTextTokens(block.text);
		else if (block.type === "thinking") tokens += estimateTextTokens(block.thinking);
		else if (block.type === "toolCall") {
			tokens += estimateTextTokens(block.name);
			tokens += estimateJsonTokens(block.arguments);
		}
	}
	return tokens;
}

function estimateToolResultMessageTokens(message: ToolResultMessage): number {
	return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.toolName) + estimateContentTokens(message.content);
}

function estimateFallbackMessageTokens(message: AgentMessage): number {
	const text = JSON.stringify(message) ?? "";
	return text ? MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(text) : 0;
}

function resolveFreshTailStartIndex(
	items: readonly LcmContextRawItem[],
	config: Pick<LcmContextCompactionConfig, "freshTailCount" | "freshTailMaxTokens">,
): number {
	const protectedByCountStart = Math.max(0, items.length - Math.max(0, config.freshTailCount));
	if (config.freshTailMaxTokens === undefined) return protectedByCountStart;

	let tokenStart = items.length;
	let tokens = 0;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (!item) continue;
		if (tokens + item.tokens > config.freshTailMaxTokens) break;
		tokens += item.tokens;
		tokenStart = index;
	}
	return Math.min(protectedByCountStart, tokenStart);
}

function selectOldestLeafChunk(items: readonly LcmContextRawItem[], leafChunkTokens: number): LcmContextRawItem[] {
	const chunk: LcmContextRawItem[] = [];
	let tokens = 0;
	for (const item of items) {
		if (chunk.length > 0 && tokens + item.tokens > leafChunkTokens) break;
		chunk.push(item);
		tokens += item.tokens;
		if (tokens >= leafChunkTokens) break;
	}
	return chunk;
}

function estimateContentTokens(content: UserMessage["content"] | ToolResultMessage["content"]): number {
	if (typeof content === "string") return estimateTextTokens(content);
	let tokens = 0;
	for (const block of content) {
		if (block.type === "text") tokens += estimateTextTokens(block.text);
		else if (block.type === "image") tokens += IMAGE_TOKEN_ESTIMATE;
	}
	return tokens;
}

function estimateJsonTokens(value: unknown): number {
	return estimateTextTokens(JSON.stringify(value) ?? "");
}

function renderAttachmentForEstimate(attachment: LcmAttachmentNote): string {
	return [attachment.name, attachment.kind, attachment.mimeType, attachment.text, attachment.note]
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join(" ");
}

function isConversationRecord(record: StoredLcmRecord): boolean {
	return record.kind === "user" || record.kind === "assistant";
}

function selectRetainedSummaries(summaries: readonly StoredLcmSummary[]): StoredLcmSummary[] {
	return summaries
		.filter((summary) => summary.status === "ready" && summary.text.trim().length > 0)
		.sort(compareSummaries);
}

function compareRecords(a: StoredLcmRecord, b: StoredLcmRecord): number {
	return Date.parse(a.happenedAt) - Date.parse(b.happenedAt) || a.id - b.id;
}

function compareSummaries(a: StoredLcmSummary, b: StoredLcmSummary): number {
	return (
		Number(b.pinned) - Number(a.pinned) ||
		a.segmentId.localeCompare(b.segmentId) ||
		b.depth - a.depth ||
		(a.coversFromRecordId ?? Number.MAX_SAFE_INTEGER) - (b.coversFromRecordId ?? Number.MAX_SAFE_INTEGER) ||
		a.id - b.id
	);
}

function nonNegativeInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
	return value;
}

function optionalNonNegativeInteger(value: number | undefined, name: string): number | null {
	if (value === undefined) return null;
	return nonNegativeInteger(value, name);
}

function messageTextForFingerprint(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (item.type === "text") return item.text;
			if (item.type === "thinking") return item.thinking;
			if (item.type === "toolCall") return `${item.name}\n${JSON.stringify(item.arguments)}`;
			if (item.type === "image") return item.mimeType;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}
