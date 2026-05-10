import type { ChunkIndexer, ChunkIndexResult, MemoryChunkIndexInput } from "../index/chunk-indexer.js";
import type { NormalizedLcmBatch } from "./normalize.js";
import { type LcmStore, lcmRecordIndexSourceId, lcmSummaryIndexSourceId } from "./store.js";
import type { StoredLcmRecord, StoredLcmSummary } from "./types.js";

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
	const text = record.text.trim();
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
			source: summary.source,
		},
	};
}

function lcmRecordSnippet(record: StoredLcmRecord): string {
	return `[${record.kind}] ${record.text}`.slice(0, 280);
}

function lcmSummarySnippet(summary: StoredLcmSummary): string {
	return `[d${summary.depth}] ${summary.text}`.slice(0, 280);
}
