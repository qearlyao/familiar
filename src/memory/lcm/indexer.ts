import type { ChunkIndexer, ChunkIndexResult, MemoryChunkIndexInput } from "../index/chunk-indexer.js";
import type { NormalizedLcmBatch } from "./normalize.js";
import { type LcmStore, lcmRecordIndexSourceId, lcmSummaryIndexSourceId } from "./store.js";
import type { LcmRecordPart, StoredLcmRecord, StoredLcmSummary } from "./types.js";

export const LCM_RECORD_CORPUS = "lcm_record";
export const LCM_SUMMARY_CORPUS = "lcm_summary";

export interface ProjectNormalizedLcmBatchOptions {
	batch: NormalizedLcmBatch;
	lcmStore: LcmStore;
	indexer: ChunkIndexer;
	signal?: AbortSignal;
}

export interface ProjectNormalizedLcmBatchResult {
	segmentIds: string[];
	recordIds: number[];
	recordIndex: ChunkIndexResult;
}

export interface IndexLcmRecordsOptions {
	indexer: ChunkIndexer;
	records: readonly StoredLcmRecord[];
	signal?: AbortSignal;
}

export interface IndexLcmSummariesOptions {
	indexer: ChunkIndexer;
	summaries: readonly StoredLcmSummary[];
	signal?: AbortSignal;
}

export async function projectNormalizedLcmBatch(
	options: ProjectNormalizedLcmBatchOptions,
): Promise<ProjectNormalizedLcmBatchResult> {
	const segmentIds: string[] = [];
	for (const segment of options.batch.segments) {
		segmentIds.push(options.lcmStore.ensureSegment(segment).id);
	}

	const storedRecords: StoredLcmRecord[] = [];
	for (const record of options.batch.records) {
		const id = options.lcmStore.insertRecord(record);
		const stored = options.lcmStore.getRecord(id);
		if (!stored) throw new Error(`Failed to read projected LCM record: ${id}`);
		storedRecords.push(stored);
	}

	return {
		segmentIds,
		recordIds: storedRecords.map((record) => record.id),
		recordIndex: await indexLcmRecords({ indexer: options.indexer, records: storedRecords, signal: options.signal }),
	};
}

export async function indexLcmRecords(options: IndexLcmRecordsOptions): Promise<ChunkIndexResult> {
	return options.indexer.indexChunks(lcmRecordsToIndexInputs(options.records), options.signal);
}

export async function indexLcmSummaries(options: IndexLcmSummariesOptions): Promise<ChunkIndexResult> {
	return options.indexer.indexChunks(lcmSummariesToIndexInputs(options.summaries), options.signal);
}

export function lcmRecordsToIndexInputs(records: readonly StoredLcmRecord[]): MemoryChunkIndexInput[] {
	return records.map(lcmRecordToIndexInput).filter((input): input is MemoryChunkIndexInput => input !== null);
}

export function lcmSummariesToIndexInputs(summaries: readonly StoredLcmSummary[]): MemoryChunkIndexInput[] {
	return summaries.map(lcmSummaryToIndexInput).filter((input): input is MemoryChunkIndexInput => input !== null);
}

export function lcmRecordToIndexInput(record: StoredLcmRecord): MemoryChunkIndexInput | null {
	const text = memoryTextForLcmRecord(record);
	if (!text) return null;
	return {
		corpus: LCM_RECORD_CORPUS,
		sourceId: lcmRecordIndexSourceId(record.id),
		sourceRef: record.source.sourceRef ?? null,
		chunkIndex: 0,
		text,
		snippet: lcmRecordSnippet(record),
		metadata: {
			id: record.id,
			kind: record.kind,
			segmentId: record.segmentId,
			timestamp: record.happenedAt,
			happenedAt: record.happenedAt,
			sessionId: record.sessionId,
			channelKey: record.channelKey,
			channelId: record.channelId,
			jobId: record.jobId,
			source: record.source,
		},
	};
}

export function lcmSummaryToIndexInput(summary: StoredLcmSummary): MemoryChunkIndexInput | null {
	const text = summary.text.trim();
	if (!text || summary.status !== "ready") return null;
	return {
		corpus: LCM_SUMMARY_CORPUS,
		sourceId: lcmSummaryIndexSourceId(summary.id),
		sourceRef: summary.source.sourceRef ?? null,
		chunkIndex: 0,
		text,
		snippet: lcmSummarySnippet(summary),
		metadata: {
			id: summary.id,
			segmentId: summary.segmentId,
			depth: summary.depth,
			status: summary.status,
			pinned: summary.pinned,
			coversFromRecordId: summary.coversFromRecordId,
			coversToRecordId: summary.coversToRecordId,
			...summaryCoverageMetadata(summary),
			source: summary.source,
		},
	};
}

function lcmRecordSnippet(record: StoredLcmRecord): string {
	return `[${record.kind}] ${memoryTextForLcmRecord(record)}`.slice(0, 280);
}

function lcmSummarySnippet(summary: StoredLcmSummary): string {
	return `[d${summary.depth}] ${summary.text}`.slice(0, 280);
}

function summaryCoverageMetadata(summary: StoredLcmSummary): Record<string, string> {
	const existingFrom = metadataString(summary.metadata?.coverageFromHappenedAt);
	const existingTo =
		metadataString(summary.metadata?.coverageToHappenedAt) ?? metadataString(summary.metadata?.timestamp);
	const from = existingFrom ?? firstSnapshotHappenedAt(summary.snapshot);
	const to = existingTo ?? lastSnapshotHappenedAt(summary.snapshot);
	return {
		...(from ? { coverageFromHappenedAt: from } : {}),
		...(to ? { coverageToHappenedAt: to, timestamp: to } : {}),
	};
}

function metadataString(value: unknown): string | null {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function firstSnapshotHappenedAt(snapshot: StoredLcmSummary["snapshot"]): string | null {
	if (!Array.isArray(snapshot)) return null;
	for (const item of snapshot) {
		if (isSnapshotRecord(item) && isIsoTimeString(item.happened_at)) return item.happened_at;
		const nested = isParentSnapshot(item) ? firstSnapshotHappenedAt(item.snapshot) : null;
		if (nested) return nested;
	}
	return null;
}

function lastSnapshotHappenedAt(snapshot: StoredLcmSummary["snapshot"]): string | null {
	if (!Array.isArray(snapshot)) return null;
	for (let index = snapshot.length - 1; index >= 0; index -= 1) {
		const item = snapshot[index];
		if (isSnapshotRecord(item) && isIsoTimeString(item.happened_at)) return item.happened_at;
		const nested = isParentSnapshot(item) ? lastSnapshotHappenedAt(item.snapshot) : null;
		if (nested) return nested;
	}
	return null;
}

function isSnapshotRecord(item: unknown): item is { happened_at: string } {
	return typeof item === "object" && item !== null && "happened_at" in item;
}

function isParentSnapshot(item: unknown): item is { snapshot: StoredLcmSummary["snapshot"] } {
	return typeof item === "object" && item !== null && "snapshot" in item;
}

function isIsoTimeString(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function memoryTextForLcmRecord(record: StoredLcmRecord): string {
	if (record.kind === "user") return visibleTextFromRecord(record);
	if (record.kind === "assistant") return visibleTextFromRecord(record);
	if (record.kind === "note" || record.kind === "boundary") return record.text.trim();
	return "";
}

function visibleTextFromRecord(record: StoredLcmRecord): string {
	if (!record.parts?.length) return normalizeVisibleText(record.text, record.kind).trim();
	const text = record.parts
		.filter((part): part is Extract<LcmRecordPart, { kind: "text" }> => part.kind === "text")
		.map((part) => part.text.trim())
		.filter(Boolean)
		.join("\n")
		.trim();
	return normalizeVisibleText(text, record.kind).trim();
}

function normalizeVisibleText(text: string, kind: StoredLcmRecord["kind"]): string {
	const visible = kind === "assistant" ? stripNoisyRecordMarkers(text) : text;
	return collapseDuplicatedVisibleText(visible);
}

function stripNoisyRecordMarkers(text: string): string {
	return text
		.split(/\r?\n/)
		.filter((line) => !isNoisyRecordMarkerLine(line))
		.join("\n");
}

function isNoisyRecordMarkerLine(line: string): boolean {
	const trimmed = line.trim();
	if (/^\[(?:thinking|tool_call|tool_result)\]$/.test(trimmed)) return true;
	if (/^\[thinking\]\s*\S/.test(trimmed)) return true;
	if (/^\[tool_call:\s*[\w.-]+\s*\(.*\)\]$/.test(trimmed)) return true;
	if (/^\[tool_result:\s*[\w.-]+\s*->\s*.*\]$/.test(trimmed)) return true;
	return false;
}

function collapseDuplicatedVisibleText(text: string): string {
	let normalized = text.trim();
	for (let iteration = 0; iteration < 4; iteration += 1) {
		const collapsed = collapseOnce(normalized);
		if (collapsed === normalized) return normalized;
		normalized = collapsed;
	}
	return normalized;
}

function collapseOnce(text: string): string {
	for (let split = Math.floor(text.length / 2); split >= 24; split -= 1) {
		const left = text.slice(0, split).trim();
		const right = text.slice(split).trim();
		if (left && normalizeComparableText(left) === normalizeComparableText(right)) return left;
	}
	return text;
}

function normalizeComparableText(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}
