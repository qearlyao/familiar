import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import type { Config } from "../../config.js";
import { readMeta, runLcmMigrations } from "./schema.js";
import type {
	LcmRecordInput,
	LcmRecordKind,
	LcmRetentionOptions,
	LcmRetentionReport,
	LcmSegmentInput,
	LcmSegmentStatus,
	LcmSourceProvenance,
	LcmSummaryInput,
	LcmSummarySourceInput,
	LcmSummaryStatus,
	StoredLcmRecord,
	StoredLcmSegment,
	StoredLcmSummary,
	StoredLcmSummarySource,
} from "./types.js";

interface StoreOptions {
	path?: string;
	db?: Database.Database;
}

interface LcmSegmentRow {
	id: string;
	status: string;
	session_id: string | null;
	channel_key: string | null;
	started_at: string;
	closed_at: string | null;
	raw_pruned_at: string | null;
	boundary_source_json: string | null;
	metadata_json: string | null;
	created_at: number;
	updated_at: number;
}

interface LcmRecordRow {
	id: number;
	record_key: string;
	segment_id: string;
	kind: string;
	text_full: string;
	happened_at: string;
	session_id: string | null;
	channel_key: string | null;
	channel_id: string | null;
	job_id: string | null;
	source_type: string;
	source_path: string | null;
	source_line: number | null;
	source_record_id: string | null;
	source_message_id: string | null;
	source_ref: string | null;
	attachments_json: string | null;
	metadata_json: string | null;
	created_at: number;
	updated_at: number;
}

interface LcmSummaryRow {
	id: number;
	summary_key: string;
	segment_id: string;
	depth: number;
	status: string;
	text_full: string;
	pinned: number;
	covers_from_record_id: number | null;
	covers_to_record_id: number | null;
	source_type: string;
	source_path: string | null;
	source_line: number | null;
	source_record_id: string | null;
	source_message_id: string | null;
	source_ref: string | null;
	metadata_json: string | null;
	created_at: number;
	updated_at: number;
}

interface LcmSummarySourceRow {
	summary_id: number;
	ord: number;
	record_id: number | null;
	source_summary_id: number | null;
	source_ref: string | null;
	snapshot_json: string | null;
}

export class LcmStore {
	readonly db: Database.Database;
	private readonly ownsDb: boolean;

	constructor(options: StoreOptions) {
		if (!options.db && !options.path) throw new Error("LcmStore requires a db or path");
		if (options.db) {
			this.db = options.db;
			this.ownsDb = false;
		} else {
			const path = options.path as string;
			mkdirSync(dirname(path), { recursive: true });
			this.db = new Database(path);
			this.ownsDb = true;
		}
		runLcmMigrations(this.db);
	}

	static open(config: Config, path = resolve(config.memory.lcmDir, "lcm.sqlite")): LcmStore {
		return new LcmStore({ path });
	}

	close(): void {
		if (this.ownsDb) this.db.close();
	}

	schemaVersion(): number | null {
		const raw = readMeta(this.db, "schema_version");
		return raw ? Number(raw) : null;
	}

	ensureSegment(input: LcmSegmentInput): StoredLcmSegment {
		const startedAt = input.startedAt ?? new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO lcm_segments (
					id, session_id, channel_key, started_at, boundary_source_json, metadata_json
				 ) VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					session_id = COALESCE(excluded.session_id, lcm_segments.session_id),
					channel_key = COALESCE(excluded.channel_key, lcm_segments.channel_key),
					boundary_source_json = COALESCE(excluded.boundary_source_json, lcm_segments.boundary_source_json),
					metadata_json = COALESCE(excluded.metadata_json, lcm_segments.metadata_json),
					updated_at = unixepoch()`,
			)
			.run(
				input.id,
				input.sessionId ?? null,
				input.channelKey ?? null,
				startedAt,
				jsonOrNull(input.boundarySource ?? null),
				jsonOrNull(input.metadata ?? null),
			);
		const segment = this.getSegment(input.id);
		if (!segment) throw new Error(`Failed to create LCM segment: ${input.id}`);
		return segment;
	}

	closeSegment(id: string, closedAt = new Date().toISOString()): void {
		this.db
			.prepare(
				`UPDATE lcm_segments
				 SET status = 'closed', closed_at = ?, updated_at = unixepoch()
				 WHERE id = ?`,
			)
			.run(closedAt, id);
	}

	getSegment(id: string): StoredLcmSegment | null {
		const row = this.db.prepare("SELECT * FROM lcm_segments WHERE id = ?").get(id) as LcmSegmentRow | undefined;
		return row ? segmentFromRow(row) : null;
	}

	listSegments(): StoredLcmSegment[] {
		const rows = this.db.prepare("SELECT * FROM lcm_segments ORDER BY started_at, id").all() as LcmSegmentRow[];
		return rows.map(segmentFromRow);
	}

	insertRecord(input: LcmRecordInput): number {
		const normalized = normalizeRecordInput(input);
		this.ensureSegment({
			id: normalized.segmentId,
			sessionId: normalized.sessionId,
			channelKey: normalized.channelKey,
			startedAt: normalized.happenedAt,
		});
		const existing = this.db.prepare("SELECT id FROM lcm_records WHERE record_key = ?").get(normalized.recordKey) as
			| { id: number }
			| undefined;
		if (existing) return existing.id;

		const result = this.db
			.transaction(() => {
				const inserted = this.db
					.prepare(
						`INSERT INTO lcm_records (
							record_key, segment_id, kind, text_full, happened_at, session_id, channel_key,
							channel_id, job_id, source_type, source_path, source_line, source_record_id,
							source_message_id, source_ref, attachments_json, metadata_json
						 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						normalized.recordKey,
						normalized.segmentId,
						normalized.kind,
						normalized.text,
						normalized.happenedAt,
						normalized.sessionId,
						normalized.channelKey,
						normalized.channelId,
						normalized.jobId,
						normalized.source.sourceType,
						normalized.source.sourcePath ?? null,
						normalized.source.sourceLine ?? null,
						sourceRecordIdToString(normalized.source.sourceRecordId),
						normalized.source.sourceMessageId ?? null,
						normalized.source.sourceRef ?? null,
						jsonOrNull(normalized.attachments),
						jsonOrNull(normalized.metadata),
					);
				const id = Number(inserted.lastInsertRowid);
				this.db.prepare("INSERT INTO lcm_records_fts(rowid, text_full) VALUES (?, ?)").run(id, normalized.text);
				return id;
			})
			.immediate();
		return result;
	}

	getRecord(id: number): StoredLcmRecord | null {
		const row = this.db.prepare("SELECT * FROM lcm_records WHERE id = ?").get(id) as LcmRecordRow | undefined;
		return row ? recordFromRow(row) : null;
	}

	listRecords(segmentId?: string): StoredLcmRecord[] {
		const rows = (
			segmentId
				? this.db.prepare("SELECT * FROM lcm_records WHERE segment_id = ? ORDER BY happened_at, id").all(segmentId)
				: this.db.prepare("SELECT * FROM lcm_records ORDER BY happened_at, id").all()
		) as LcmRecordRow[];
		return rows.map(recordFromRow);
	}

	searchRecordsLexical(query: string, limit = 10): StoredLcmRecord[] {
		const rows = this.db
			.prepare(
				`SELECT r.*
				 FROM lcm_records_fts f
				 JOIN lcm_records r ON r.id = f.rowid
				 WHERE lcm_records_fts MATCH ?
				 ORDER BY f.rank
				 LIMIT ?`,
			)
			.all(query, limit) as LcmRecordRow[];
		return rows.map(recordFromRow);
	}

	insertSummary(input: LcmSummaryInput): number {
		if (!Number.isInteger(input.depth) || input.depth < 0) {
			throw new Error("LCM summary depth must be an integer >= 0");
		}
		const normalized = normalizeSummaryInput(input);
		this.ensureSegment({ id: normalized.segmentId });
		const existing = this.db
			.prepare("SELECT id FROM lcm_summaries WHERE summary_key = ?")
			.get(normalized.summaryKey) as { id: number } | undefined;
		if (existing) return existing.id;

		const result = this.db
			.transaction(() => {
				const inserted = this.db
					.prepare(
						`INSERT INTO lcm_summaries (
							summary_key, segment_id, depth, status, text_full, pinned,
							covers_from_record_id, covers_to_record_id, source_type, source_path,
							source_line, source_record_id, source_message_id, source_ref, metadata_json
						 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						normalized.summaryKey,
						normalized.segmentId,
						normalized.depth,
						normalized.status,
						normalized.text,
						normalized.pinned ? 1 : 0,
						normalized.coversFromRecordId,
						normalized.coversToRecordId,
						normalized.source.sourceType,
						normalized.source.sourcePath ?? null,
						normalized.source.sourceLine ?? null,
						sourceRecordIdToString(normalized.source.sourceRecordId),
						normalized.source.sourceMessageId ?? null,
						normalized.source.sourceRef ?? null,
						jsonOrNull(normalized.metadata),
					);
				const id = Number(inserted.lastInsertRowid);
				this.db.prepare("INSERT INTO lcm_summaries_fts(rowid, text_full) VALUES (?, ?)").run(id, normalized.text);
				this.insertSummarySources(id, normalized.sourceItems);
				return id;
			})
			.immediate();
		return result;
	}

	getSummary(id: number): StoredLcmSummary | null {
		const row = this.db.prepare("SELECT * FROM lcm_summaries WHERE id = ?").get(id) as LcmSummaryRow | undefined;
		return row ? summaryFromRow(row) : null;
	}

	listSummaries(segmentId?: string): StoredLcmSummary[] {
		const rows = (
			segmentId
				? this.db.prepare("SELECT * FROM lcm_summaries WHERE segment_id = ? ORDER BY depth, id").all(segmentId)
				: this.db.prepare("SELECT * FROM lcm_summaries ORDER BY segment_id, depth, id").all()
		) as LcmSummaryRow[];
		return rows.map(summaryFromRow);
	}

	getSummarySources(summaryId: number): StoredLcmSummarySource[] {
		const rows = this.db
			.prepare("SELECT * FROM lcm_summary_sources WHERE summary_id = ? ORDER BY ord")
			.all(summaryId) as LcmSummarySourceRow[];
		return rows.map(summarySourceFromRow);
	}

	applyNewSessionRetention(options: LcmRetentionOptions): LcmRetentionReport {
		const retainDepth = options.newSessionRetainDepth;
		if (!Number.isInteger(retainDepth) || retainDepth < -1) {
			throw new Error("newSessionRetainDepth must be an integer >= -1");
		}
		const report: LcmRetentionReport = {
			retainDepth,
			affectedSegments: [],
			rawRecordsDeleted: 0,
			summariesDeleted: 0,
			recordFtsRowsDeleted: 0,
			summaryFtsRowsDeleted: 0,
			indexDeletes: [],
		};
		if (retainDepth === -1) return report;

		this.db
			.transaction(() => {
				const segmentRows = this.db
					.prepare(
						`SELECT id FROM lcm_segments
						 WHERE status = 'closed'
						 ${options.activeSegmentId ? "AND id != ?" : ""}
						 ORDER BY started_at, id`,
					)
					.all(...(options.activeSegmentId ? [options.activeSegmentId] : [])) as { id: string }[];
				const segmentIds = segmentRows.map((row) => row.id);
				report.affectedSegments = segmentIds;
				if (segmentIds.length === 0) return;

				for (const segmentId of segmentIds) {
					if (retainDepth > 0) {
						const summaries = this.db
							.prepare("SELECT id FROM lcm_summaries WHERE segment_id = ? AND pinned = 0 AND depth < ?")
							.all(segmentId, retainDepth) as { id: number }[];
						for (const summary of summaries) {
							report.indexDeletes.push({ corpus: "lcm_summary", sourceId: lcmSummaryIndexSourceId(summary.id) });
							report.summaryFtsRowsDeleted += this.db
								.prepare("DELETE FROM lcm_summaries_fts WHERE rowid = ?")
								.run(summary.id).changes;
						}
						report.summariesDeleted += this.db
							.prepare("DELETE FROM lcm_summaries WHERE segment_id = ? AND pinned = 0 AND depth < ?")
							.run(segmentId, retainDepth).changes;
					}

					const records = this.db.prepare("SELECT id FROM lcm_records WHERE segment_id = ?").all(segmentId) as {
						id: number;
					}[];
					for (const record of records) {
						report.indexDeletes.push({ corpus: "lcm_record", sourceId: lcmRecordIndexSourceId(record.id) });
						report.recordFtsRowsDeleted += this.db
							.prepare("DELETE FROM lcm_records_fts WHERE rowid = ?")
							.run(record.id).changes;
					}
					report.rawRecordsDeleted += this.db
						.prepare("DELETE FROM lcm_records WHERE segment_id = ?")
						.run(segmentId).changes;
					this.db
						.prepare("UPDATE lcm_segments SET raw_pruned_at = ?, updated_at = unixepoch() WHERE id = ?")
						.run(new Date().toISOString(), segmentId);
				}
			})
			.immediate();

		if (options.vacuum) this.db.exec("VACUUM");
		return report;
	}

	private insertSummarySources(summaryId: number, sources: LcmSummarySourceInput[]): void {
		const insert = this.db.prepare(
			`INSERT INTO lcm_summary_sources (
				summary_id, ord, record_id, source_summary_id, source_ref, snapshot_json
			 ) VALUES (?, ?, ?, ?, ?, ?)`,
		);
		for (const [index, source] of sources.entries()) {
			insert.run(
				summaryId,
				index,
				source.recordId ?? null,
				source.summaryId ?? null,
				source.sourceRef ?? null,
				jsonOrNull(source.snapshot ?? null),
			);
		}
	}
}

export function lcmRecordIndexSourceId(id: number): string {
	return `lcm_record:${id}`;
}

export function lcmSummaryIndexSourceId(id: number): string {
	return `lcm_summary:${id}`;
}

function normalizeRecordInput(input: LcmRecordInput): NormalizedRecordInput {
	const text = (input.text ?? "").trim();
	if (!text && input.kind !== "boundary") throw new Error("LCM record text must not be empty");
	const source = normalizeSource(input.source);
	const happenedAt = input.happenedAt ?? new Date().toISOString();
	const normalizedText = text || "Session boundary";
	return {
		segmentId: input.segmentId,
		kind: input.kind,
		text: normalizedText,
		happenedAt,
		sessionId: input.sessionId ?? null,
		channelKey: input.channelKey ?? null,
		channelId: input.channelId ?? null,
		jobId: input.jobId ?? null,
		source,
		attachments: input.attachments?.length ? input.attachments : null,
		metadata: input.metadata ?? null,
		recordKey: stableHash({
			segmentId: input.segmentId,
			kind: input.kind,
			text: normalizedText,
			happenedAt,
			source,
		}),
	};
}

function normalizeSummaryInput(input: LcmSummaryInput): NormalizedSummaryInput {
	const text = (input.text ?? "").trim();
	const source = normalizeSource(input.source);
	const status = input.status ?? (text ? "ready" : "placeholder");
	const normalizedText = text || "";
	return {
		segmentId: input.segmentId,
		depth: input.depth,
		status,
		text: normalizedText,
		pinned: input.pinned ?? false,
		coversFromRecordId: input.coversFromRecordId ?? null,
		coversToRecordId: input.coversToRecordId ?? null,
		source,
		sourceItems: input.sourceItems ?? [],
		metadata: input.metadata ?? null,
		summaryKey: stableHash({
			segmentId: input.segmentId,
			depth: input.depth,
			status,
			text: normalizedText,
			coversFromRecordId: input.coversFromRecordId ?? null,
			coversToRecordId: input.coversToRecordId ?? null,
			source,
		}),
	};
}

function normalizeSource(source: LcmSourceProvenance): LcmSourceProvenance {
	return {
		sourceType: source.sourceType,
		sourcePath: source.sourcePath ?? null,
		sourceLine: source.sourceLine ?? null,
		sourceRecordId: source.sourceRecordId ?? null,
		sourceMessageId: source.sourceMessageId ?? null,
		sourceRef: source.sourceRef ?? null,
	};
}

function stableHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceRecordIdToString(value: number | string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return String(value);
}

function jsonOrNull(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return JSON.stringify(value);
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function parseJsonArray<T>(value: string | null): T[] | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? (parsed as T[]) : null;
	} catch {
		return null;
	}
}

function sourceFromRow(row: {
	source_type: string;
	source_path: string | null;
	source_line: number | null;
	source_record_id: string | null;
	source_message_id: string | null;
	source_ref: string | null;
}): LcmSourceProvenance {
	return {
		sourceType: row.source_type as LcmSourceProvenance["sourceType"],
		sourcePath: row.source_path,
		sourceLine: row.source_line,
		sourceRecordId: row.source_record_id,
		sourceMessageId: row.source_message_id,
		sourceRef: row.source_ref,
	};
}

function segmentFromRow(row: LcmSegmentRow): StoredLcmSegment {
	return {
		id: row.id,
		status: row.status as LcmSegmentStatus,
		sessionId: row.session_id,
		channelKey: row.channel_key,
		startedAt: row.started_at,
		closedAt: row.closed_at,
		rawPrunedAt: row.raw_pruned_at,
		boundarySource: parseJsonObject(row.boundary_source_json) as LcmSourceProvenance | null,
		metadata: parseJsonObject(row.metadata_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function recordFromRow(row: LcmRecordRow): StoredLcmRecord {
	return {
		id: row.id,
		recordKey: row.record_key,
		segmentId: row.segment_id,
		kind: row.kind as LcmRecordKind,
		text: row.text_full,
		happenedAt: row.happened_at,
		sessionId: row.session_id,
		channelKey: row.channel_key,
		channelId: row.channel_id,
		jobId: row.job_id,
		source: sourceFromRow(row),
		attachments: parseJsonArray(row.attachments_json),
		metadata: parseJsonObject(row.metadata_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function summaryFromRow(row: LcmSummaryRow): StoredLcmSummary {
	return {
		id: row.id,
		summaryKey: row.summary_key,
		segmentId: row.segment_id,
		depth: row.depth,
		status: row.status as LcmSummaryStatus,
		text: row.text_full,
		pinned: row.pinned === 1,
		coversFromRecordId: row.covers_from_record_id,
		coversToRecordId: row.covers_to_record_id,
		source: sourceFromRow(row),
		metadata: parseJsonObject(row.metadata_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function summarySourceFromRow(row: LcmSummarySourceRow): StoredLcmSummarySource {
	return {
		summaryId: row.summary_id,
		ord: row.ord,
		recordId: row.record_id,
		sourceSummaryId: row.source_summary_id,
		sourceRef: row.source_ref,
		snapshot: parseJsonObject(row.snapshot_json),
	};
}

interface NormalizedRecordInput {
	recordKey: string;
	segmentId: string;
	kind: LcmRecordKind;
	text: string;
	happenedAt: string;
	sessionId: string | null;
	channelKey: string | null;
	channelId: string | null;
	jobId: string | null;
	source: LcmSourceProvenance;
	attachments: LcmRecordInput["attachments"] | null;
	metadata: Record<string, unknown> | null;
}

interface NormalizedSummaryInput {
	summaryKey: string;
	segmentId: string;
	depth: number;
	status: LcmSummaryStatus;
	text: string;
	pinned: boolean;
	coversFromRecordId: number | null;
	coversToRecordId: number | null;
	source: LcmSourceProvenance;
	sourceItems: LcmSummarySourceInput[];
	metadata: Record<string, unknown> | null;
}
