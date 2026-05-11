import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ChatLogRecord } from "../../chat-log.js";
import type { Config } from "../../config.js";
import type { ChunkIndexer } from "../index/chunk-indexer.js";
import type { EmbeddingProvider } from "../index/embedding-provider.js";
import type { MemoryIndexStore } from "../index/store.js";
import { indexLcmRecords } from "./indexer.js";
import { normalizeChatRecords } from "./normalize.js";
import type { LcmStore } from "./store.js";
import type { LcmRecordInput, StoredLcmRecord } from "./types.js";

export interface BackfillDeps {
	lcmStore: LcmStore;
	memoryStore: MemoryIndexStore;
	indexer: ChunkIndexer;
	embeddingProvider: EmbeddingProvider;
	config: Config;
}

export interface BackfillOptions {
	dataDir: string;
	channels?: string[];
	dryRun?: boolean;
	yieldEveryN?: number;
	signal?: AbortSignal;
	onProgress?: (event: BackfillProgress) => void;
}

export interface BackfillReport {
	chatFilesProcessed: number;
	transcriptFilesProcessed: number;
	recordsInserted: number;
	recordsSkippedDuplicate: number;
	segmentsCreated: number;
	summariesInserted: number;
	indexedChunks: number;
	errors: string[];
}

export interface BackfillProgress {
	phase: string;
	file?: string;
	recordsProcessed: number;
	report: Partial<BackfillReport>;
}

interface ChatFile {
	channelKey: string;
	filePath: string;
	sourcePath: string;
}

interface SegmentGroup {
	segmentId: string;
	records: ChatLogRecord[];
}

const DEFAULT_YIELD_EVERY_N = 1024;
const INDEX_BATCH_SIZE = 32;

export async function backfillFromChatLogs(deps: BackfillDeps, options: BackfillOptions): Promise<BackfillReport> {
	void deps.memoryStore;
	void deps.embeddingProvider;
	const report = emptyReport();
	const dataDir = resolve(options.dataDir);
	const yieldEveryN = options.yieldEveryN ?? DEFAULT_YIELD_EVERY_N;
	const channels = options.channels ? new Set(options.channels) : null;
	let recordsProcessed = 0;

	const emit = (phase: string, file?: string) => {
		options.onProgress?.({ phase, file, recordsProcessed, report: { ...report } });
	};
	const tick = async () => {
		if (options.signal?.aborted) return false;
		if (yieldEveryN > 0 && recordsProcessed > 0 && recordsProcessed % yieldEveryN === 0) {
			await new Promise((resolveYield) => setTimeout(resolveYield, 0));
		}
		return !options.signal?.aborted;
	};

	for (const chatFile of await listChatFiles(dataDir, channels, report)) {
		if (options.signal?.aborted) break;
		emit("chat_file", chatFile.sourcePath);
		let records: ChatLogRecord[];
		try {
			records = await readChatLogFile(chatFile.filePath);
		} catch (error) {
			report.errors.push(formatError(`Failed to read chat log ${chatFile.sourcePath}`, error));
			continue;
		}
		report.chatFilesProcessed += 1;
		for (const group of groupByBackfillSegment(chatFile.channelKey, records)) {
			if (options.signal?.aborted) break;
			recordsProcessed += group.records.length;
			const batch = normalizeChatRecords(group.records, {
				segmentId: group.segmentId,
				sessionId: group.segmentId,
				channelKey: chatFile.channelKey,
				sourcePath: chatFile.sourcePath,
			});
			if (batch.segments.length === 0 && batch.records.length === 0) {
				if (!(await tick())) break;
				continue;
			}
			if (options.dryRun) {
				report.segmentsCreated += countMissingSegments(
					deps.lcmStore,
					batch.segments.map((segment) => segment.id),
				);
				const existing = countExistingRecords(deps.lcmStore, batch.records);
				report.recordsSkippedDuplicate += existing;
				report.recordsInserted += batch.records.length - existing;
			} else {
				for (const segment of batch.segments) {
					if (!deps.lcmStore.getSegment(segment.id)) report.segmentsCreated += 1;
					deps.lcmStore.ensureSegment(segment);
				}
				const inserted: StoredLcmRecord[] = [];
				for (const record of batch.records) {
					if (recordExists(deps.lcmStore, record)) {
						report.recordsSkippedDuplicate += 1;
						continue;
					}
					const id = deps.lcmStore.insertRecord(record);
					const stored = deps.lcmStore.getRecord(id);
					if (!stored) throw new Error(`Failed to read backfilled LCM record: ${id}`);
					inserted.push(stored);
					report.recordsInserted += 1;
					if (inserted.length >= INDEX_BATCH_SIZE) {
						report.indexedChunks += (
							await indexLcmRecords({ indexer: deps.indexer, records: inserted, signal: options.signal })
						).ids.length;
						inserted.length = 0;
					}
				}
				if (inserted.length > 0) {
					report.indexedChunks += (
						await indexLcmRecords({ indexer: deps.indexer, records: inserted, signal: options.signal })
					).ids.length;
				}
			}
			if (!(await tick())) break;
			emit("chat_records", chatFile.sourcePath);
		}
	}

	for (const transcriptPath of await listTranscriptFiles(dataDir, report)) {
		if (options.signal?.aborted) break;
		report.transcriptFilesProcessed += 1;
		emit("transcript_file", relative(dataDir, transcriptPath));
		// TODO: Transcript JSONL rows do not currently have a Familiar-owned, typed
		// schema that can be safely matched to ChatLogRecord by (jobId, timestamp).
		// Keep transcript discovery here, but avoid force-fitting structured parts.
		if (!(await tick())) break;
	}

	emit(options.signal?.aborted ? "aborted" : "complete");
	return report;
}

function emptyReport(): BackfillReport {
	return {
		chatFilesProcessed: 0,
		transcriptFilesProcessed: 0,
		recordsInserted: 0,
		recordsSkippedDuplicate: 0,
		segmentsCreated: 0,
		summariesInserted: 0,
		indexedChunks: 0,
		errors: [],
	};
}

async function listChatFiles(
	dataDir: string,
	channels: Set<string> | null,
	report: BackfillReport,
): Promise<ChatFile[]> {
	const chatDir = resolve(dataDir, "chat");
	let channelEntries: Dirent[];
	try {
		channelEntries = await readdir(chatDir, { withFileTypes: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		report.errors.push(formatError(`Failed to read chat directory ${chatDir}`, error));
		return [];
	}
	const files: ChatFile[] = [];
	for (const entry of channelEntries
		.filter((item) => item.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name))) {
		if (channels && !channels.has(entry.name)) continue;
		const channelDir = resolve(chatDir, entry.name);
		let dateEntries: Dirent[];
		try {
			dateEntries = await readdir(channelDir, { withFileTypes: true });
		} catch (error) {
			report.errors.push(formatError(`Failed to read channel directory ${channelDir}`, error));
			continue;
		}
		for (const file of dateEntries.filter((item) => item.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(item.name))) {
			const filePath = resolve(channelDir, file.name);
			files.push({
				channelKey: entry.name,
				filePath,
				sourcePath: relative(dataDir, filePath),
			});
		}
	}
	return files.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

async function listTranscriptFiles(dataDir: string, report: BackfillReport): Promise<string[]> {
	const transcriptDir = resolve(dataDir, "transcripts");
	let entries: Dirent[];
	try {
		entries = await readdir(transcriptDir, { withFileTypes: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		report.errors.push(formatError(`Failed to read transcript directory ${transcriptDir}`, error));
		return [];
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => resolve(transcriptDir, entry.name))
		.sort();
}

async function readChatLogFile(filePath: string): Promise<ChatLogRecord[]> {
	const content = await readFile(filePath, "utf8");
	const records: ChatLogRecord[] = [];
	for (const [index, line] of content.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		const parsed = JSON.parse(line) as unknown;
		if (!isChatLogRecord(parsed)) throw new Error(`Malformed chat log record: ${filePath}:${index + 1}`);
		records.push(parsed);
	}
	return records.sort((a, b) => a.recordId - b.recordId);
}

function isChatLogRecord(value: unknown): value is ChatLogRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.recordId === "number" && typeof record.ts === "string" && typeof record.type === "string";
}

function groupByBackfillSegment(channelKey: string, records: readonly ChatLogRecord[]): SegmentGroup[] {
	const groups: SegmentGroup[] = [];
	let current: ChatLogRecord[] = [];
	let sequence = 0;
	const flush = () => {
		const firstRecord = current[0];
		if (!firstRecord) return;
		groups.push({
			segmentId: `backfill-${channelKey}-${sanitizeSegmentIdPart(firstRecord.ts)}-${sequence}`,
			records: current,
		});
		sequence += 1;
		current = [];
	};
	for (const record of records) {
		if (record.type === "control" && record.command === "new" && current.length > 0) flush();
		current.push(record);
	}
	flush();
	return groups;
}

function sanitizeSegmentIdPart(value: string): string {
	return value.replace(/[^A-Za-z0-9._=-]+/g, "_").slice(0, 160) || "unknown";
}

function countMissingSegments(lcmStore: LcmStore, segmentIds: readonly string[]): number {
	let missing = 0;
	for (const segmentId of new Set(segmentIds)) {
		if (!lcmStore.getSegment(segmentId)) missing += 1;
	}
	return missing;
}

function countExistingRecords(lcmStore: LcmStore, records: readonly LcmRecordInput[]): number {
	let existing = 0;
	for (const record of records) {
		if (recordExists(lcmStore, record)) existing += 1;
	}
	return existing;
}

function recordExists(lcmStore: LcmStore, record: LcmRecordInput): boolean {
	return !!lcmStore.db
		.prepare(
			`SELECT 1 FROM lcm_records
			 WHERE segment_id = ?
			   AND kind = ?
			   AND happened_at = ?
			   AND source_type = ?
			   AND source_path IS ?
			   AND source_record_id IS ?
			 LIMIT 1`,
		)
		.get(
			record.segmentId,
			record.kind,
			record.happenedAt ?? null,
			record.source.sourceType,
			record.source.sourcePath ?? null,
			record.source.sourceRecordId === null || record.source.sourceRecordId === undefined
				? null
				: String(record.source.sourceRecordId),
		);
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function formatError(prefix: string, error: unknown): string {
	return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
