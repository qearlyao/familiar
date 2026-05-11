import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Provider, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

import { scoreEvictable, tokenBag } from "./eviction-score.js";
import type { LcmAttachmentNote, LcmRecordKind, LcmRecordPart, StoredLcmRecord, StoredLcmSummary } from "./types.js";

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
	promptAwareEvictionEnabled?: boolean;
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
	record?: StoredLcmRecord | null;
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

export function lcmRecordToAgentMessage(record: StoredLcmRecord): AgentMessage {
	const timestamp = Date.parse(record.happenedAt);
	const messageTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();
	if (record.parts?.length) return structuredLcmRecordToAgentMessage(record, messageTimestamp);
	if (record.kind === "assistant") return fallbackAssistantMessage(record.text, messageTimestamp);
	if (record.kind === "tool") return fallbackAssistantMessage(record.text, messageTimestamp);
	return { role: "user", content: record.text, timestamp: messageTimestamp };
}

export function renderLcmRecordPartsForSummary(parts: readonly LcmRecordPart[]): string {
	return parts
		.map((part) => {
			if (part.kind === "text") return part.text.trim();
			if (part.kind === "thinking") return part.text.trim() ? `<thinking>${part.text.trim()}</thinking>` : "";
			if (part.kind === "tool_call") {
				return `<tool_call name="${escapeXmlAttribute(part.toolName)}">${formatJsonForSummary(part.arguments)}</tool_call>`;
			}
			return `<tool_result name="${escapeXmlAttribute(part.toolName)}">${truncateForSummary(
				formatJsonForSummary(part.output),
			)}</tool_result>`;
		})
		.filter(Boolean)
		.join("\n");
}

export function selectLcmCompactionCandidate(
	items: readonly LcmContextRawItem[],
	config: LcmContextCompactionConfig,
	tokenBudget: number,
	additionalContextTokens = 0,
): LcmCompactionCandidate {
	return selectLcmCompactionCandidatePromptAware(items, config, tokenBudget, "", additionalContextTokens);
}

export function selectLcmCompactionCandidatePromptAware(
	items: readonly LcmContextRawItem[],
	config: LcmContextCompactionConfig,
	tokenBudget: number,
	promptText: string,
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
	const chunk = reasons.length > 0 ? selectLeafChunk(compactable, config.leafChunkTokens, promptText, config) : [];
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

function selectLeafChunk(
	items: readonly LcmContextRawItem[],
	leafChunkTokens: number,
	promptText: string,
	config: Pick<LcmContextCompactionConfig, "promptAwareEvictionEnabled">,
): LcmContextRawItem[] {
	if (config.promptAwareEvictionEnabled === false || tokenBag(promptText).length === 0) {
		return selectOldestLeafChunk(items, leafChunkTokens);
	}
	const ranges = createValidLeafRanges(items, leafChunkTokens);
	if (ranges.length === 0) return [];
	if (!ranges.some((range) => range.tokens >= leafChunkTokens)) return selectOldestLeafChunk(items, leafChunkTokens);
	const targetRanges = ranges.filter((range) => range.tokens >= leafChunkTokens);
	const records = items.map((item) => item.record).filter((record): record is StoredLcmRecord => !!record);
	if (records.length === 0) return selectOldestLeafChunk(items, leafChunkTokens);
	const scored = targetRanges.map((range) => ({
		...range,
		score: range.items.reduce((total, item) => total + (item.record ? scoreEvictable(item.record, promptText, records) : 0), 0),
	}));
	scored.sort((a, b) => a.score - b.score || a.startIndex - b.startIndex);
	return scored[0]?.items ?? [];
}

function createValidLeafRanges(
	items: readonly LcmContextRawItem[],
	leafChunkTokens: number,
): Array<{ startIndex: number; items: LcmContextRawItem[]; tokens: number }> {
	const ranges: Array<{ startIndex: number; items: LcmContextRawItem[]; tokens: number }> = [];
	for (let startIndex = 0; startIndex < items.length; startIndex += 1) {
		if (isToolResultContinuingPreviousToolCall(items, startIndex)) continue;
		const chunk = selectOldestLeafChunk(items.slice(startIndex), leafChunkTokens);
		if (chunk.length === 0) continue;
		const chunkTokens = chunk.reduce((total, item) => total + item.tokens, 0);
		const endIndex = startIndex + chunk.length - 1;
		const next = items[endIndex + 1];
		if (chunkTokens < leafChunkTokens && next && chunkTokens + next.tokens <= leafChunkTokens) continue;
		if (splitsFollowingToolResult(items, chunk, endIndex)) continue;
		ranges.push({ startIndex, items: chunk, tokens: chunkTokens });
	}
	return ranges;
}

function selectOldestLeafChunk(items: readonly LcmContextRawItem[], leafChunkTokens: number): LcmContextRawItem[] {
	const chunk: LcmContextRawItem[] = [];
	let tokens = 0;
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (!item) continue;
		if (chunk.length > 0 && tokens + item.tokens > leafChunkTokens && !continuesSelectedToolCall(chunk, item)) {
			break;
		}
		chunk.push(item);
		tokens += item.tokens;
		const next = items[index + 1];
		if (tokens >= leafChunkTokens && (!next || !continuesSelectedToolCall(chunk, next))) break;
	}
	return chunk;
}

function isToolResultContinuingPreviousToolCall(items: readonly LcmContextRawItem[], index: number): boolean {
	const item = items[index];
	if (!item) return false;
	const toolCallId = (item.message as { role?: string; toolCallId?: string }).toolCallId;
	if ((item.message as { role?: string }).role !== "toolResult" || !toolCallId) return false;
	return items.slice(0, index).some((previous) => hasAssistantToolCall(previous.message, toolCallId));
}

function splitsFollowingToolResult(
	items: readonly LcmContextRawItem[],
	chunk: readonly LcmContextRawItem[],
	endIndex: number,
): boolean {
	const next = items[endIndex + 1];
	if (!next) return false;
	return continuesSelectedToolCall(chunk, next);
}

function continuesSelectedToolCall(chunk: readonly LcmContextRawItem[], item: LcmContextRawItem): boolean {
	const toolCallId = (item.message as { role?: string; toolCallId?: string }).toolCallId;
	if ((item.message as { role?: string }).role !== "toolResult" || !toolCallId) return false;
	return chunk.some((chunkItem) => hasAssistantToolCall(chunkItem.message, toolCallId));
}

function hasAssistantToolCall(message: AgentMessage, toolCallId: string): boolean {
	if ((message as { role?: string }).role !== "assistant" || !("content" in message)) return false;
	const content = message.content;
	if (!Array.isArray(content)) return false;
	return content.some((item) => item.type === "toolCall" && item.id === toolCallId);
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

export function selectRetainedSummaries(summaries: readonly StoredLcmSummary[]): StoredLcmSummary[] {
	const ready = summaries
		.filter((summary) => summary.status === "ready" && summary.text.trim().length > 0)
		.sort(compareSummaries);
	const covered = new Set<number>();
	const selected: StoredLcmSummary[] = [];
	for (const summary of ready) {
		if (covered.has(summary.id)) continue;
		selected.push(summary);
		coverSummaryParents(summary, ready, covered);
	}
	return selected;
}

function coverSummaryParents(summary: StoredLcmSummary, summaries: readonly StoredLcmSummary[], covered: Set<number>): void {
	for (const parentId of summary.parents) {
		if (covered.has(parentId)) continue;
		covered.add(parentId);
		const parent = summaries.find((candidate) => candidate.id === parentId);
		if (parent) coverSummaryParents(parent, summaries, covered);
	}
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

function structuredLcmRecordToAgentMessage(record: StoredLcmRecord, timestamp: number): AgentMessage {
	if (record.kind === "tool") {
		const result = record.parts?.find((part): part is Extract<LcmRecordPart, { kind: "tool_result" }> => {
			return part.kind === "tool_result";
		});
		if (!result) return fallbackAssistantMessage(record.text, timestamp);
		return {
			role: "toolResult",
			toolCallId: result.toolCallId,
			toolName: result.toolName,
			content: [{ type: "text", text: stringifyPartValue(result.output) }],
			details: result.output,
			isError: result.isError ?? false,
			timestamp,
		};
	}
	if (record.kind === "assistant") {
		return {
			...fallbackAssistantMessage("", timestamp),
			content: structuredAssistantContent(record.parts ?? []),
			stopReason: record.parts?.some((part) => part.kind === "tool_call") ? "toolUse" : "stop",
		};
	}
	return {
		role: "user",
		content: structuredUserContent(record.parts ?? [], record.text),
		timestamp,
	};
}

function structuredAssistantContent(parts: readonly LcmRecordPart[]): AssistantMessage["content"] {
	const content: AssistantMessage["content"] = [];
	for (const part of parts) {
		if (part.kind === "text" && part.text) content.push({ type: "text", text: part.text });
		else if (part.kind === "thinking" && part.text) {
			content.push({
				type: "thinking",
				thinking: part.text,
				...(part.signature ? { thinkingSignature: part.signature } : {}),
			});
		} else if (part.kind === "tool_call") {
			content.push({
				type: "toolCall",
				id: part.toolCallId,
				name: part.toolName,
				arguments: normalizeToolArguments(part.arguments),
			});
		}
	}
	return content.length ? content : [{ type: "text", text: "" }];
}

function structuredUserContent(parts: readonly LcmRecordPart[], fallback: string): UserMessage["content"] {
	const text = parts
		.filter((part): part is Extract<LcmRecordPart, { kind: "text" }> => part.kind === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text || fallback;
}

function fallbackAssistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "lcm" as Api,
		provider: "familiar" as Provider,
		model: "lcm-record",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function normalizeToolArguments(value: unknown): Record<string, any> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function stringifyPartValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function formatJsonForSummary(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function truncateForSummary(text: string, maxLength = 2_000): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, maxLength)}\n...[truncated]`;
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
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
