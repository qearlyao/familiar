import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import type { Config } from "../../config.js";
import { normalizeFtsMatchQuery } from "../index/fts-query.js";
import { readMeta, runLcmMigrations } from "./schema.js";
import type {
	LcmContextItemInput,
	LcmRecordInput,
	LcmRecordKind,
	LcmRecordPart,
	LcmRetentionOptions,
	LcmRetentionReport,
	LcmSegmentInput,
	LcmSegmentStatus,
	LcmSourceProvenance,
	LcmSummaryInput,
	LcmSummaryParentSnapshot,
	LcmSummarySnapshot,
	LcmSummarySourceInput,
	LcmSummaryStatus,
	StoredLcmContextItem,
	StoredLcmRecord,
	StoredLcmSegment,
	StoredLcmSessionState,
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
	parts_json: string | null;
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
	snapshot_json: string | null;
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

interface LcmContextItemRow {
	session_key: string;
	ordinal: number;
	item_type: string;
	record_id: number | null;
	summary_id: number | null;
	fingerprint: string;
	happened_at: string | null;
	updated_at: number;
}

interface LcmSessionStateRow {
	session_key: string;
	compaction_debt: number;
	cache_touched_at: number | null;
	updated_at: number | null;
}

export interface LcmRecordInsertResult {
	record: StoredLcmRecord;
	inserted: boolean;
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
		this.db.pragma("foreign_keys = ON");
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

	computeRecordKey(input: LcmRecordInput): string {
		return computeLcmRecordKey(input);
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
		return this.insertRecordReturningStored(input).record.id;
	}

	insertRecordReturningStored(input: LcmRecordInput): LcmRecordInsertResult {
		const normalized = normalizeRecordInput(input);
		const runInsert = () => {
			this.ensureSegment({
				id: normalized.segmentId,
				sessionId: normalized.sessionId,
				channelKey: normalized.channelKey,
				startedAt: normalized.happenedAt,
			});
			const existing = this.db.prepare("SELECT * FROM lcm_records WHERE record_key = ?").get(normalized.recordKey) as
				| LcmRecordRow
				| undefined;
			if (existing) return { record: recordFromRow(existing), inserted: false };
			const inserted = insertRecordPrepared(this.db, normalized);
			return { record: recordFromRow(inserted), inserted: true };
		};
		return this.db.inTransaction ? runInsert() : this.db.transaction(runInsert).immediate();
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
		const matchQuery = normalizeFtsMatchQuery(query);
		if (!matchQuery) return [];
		const rows = this.db
			.prepare(
				`SELECT r.*
				 FROM lcm_records_fts f
				 JOIN lcm_records r ON r.id = f.rowid
				 WHERE lcm_records_fts MATCH ?
				 ORDER BY f.rank
				 LIMIT ?`,
			)
			.all(matchQuery, limit) as LcmRecordRow[];
		return rows.map(recordFromRow);
	}

	searchSummariesLexical(query: string, limit = 10): StoredLcmSummary[] {
		const matchQuery = normalizeFtsMatchQuery(query);
		if (!matchQuery) return [];
		const rows = this.db
			.prepare(
				`SELECT s.*
				 FROM lcm_summaries_fts f
				 JOIN lcm_summaries s ON s.id = f.rowid
				 WHERE lcm_summaries_fts MATCH ?
				 ORDER BY f.rank
				 LIMIT ?`,
			)
			.all(matchQuery, limit) as LcmSummaryRow[];
		return rows.map((row) => summaryFromRow(row));
	}

	insertSummary(input: LcmSummaryInput): number {
		if (!Number.isInteger(input.depth) || input.depth < 0) {
			throw new Error("LCM summary depth must be an integer >= 0");
		}
		const normalized = normalizeSummaryInput(input);
		const runInsert = () =>
			runSummaryInsertTransaction(this, normalized, (id, sources, parents) => {
				this.insertSummarySources(id, sources);
				this.insertSummaryParents(id, parents);
			});
		const result = this.db.inTransaction ? runInsert() : this.db.transaction(runInsert).immediate();
		return result;
	}

	getSummary(id: number): StoredLcmSummary | null {
		const row = this.db.prepare("SELECT * FROM lcm_summaries WHERE id = ?").get(id) as LcmSummaryRow | undefined;
		return row ? summaryFromRow(row, this.getSummaryParents(row.id)) : null;
	}

	listSummaries(segmentId?: string): StoredLcmSummary[] {
		const rows = (
			segmentId
				? this.db.prepare("SELECT * FROM lcm_summaries WHERE segment_id = ? ORDER BY depth, id").all(segmentId)
				: this.db.prepare("SELECT * FROM lcm_summaries ORDER BY segment_id, depth, id").all()
		) as LcmSummaryRow[];
		const parentMap = this.summaryParentMap(rows.map((row) => row.id));
		return rows.map((row) => summaryFromRow(row, parentMap.get(row.id) ?? []));
	}

	getSummarySources(summaryId: number): StoredLcmSummarySource[] {
		const rows = this.db
			.prepare("SELECT * FROM lcm_summary_sources WHERE summary_id = ? ORDER BY ord")
			.all(summaryId) as LcmSummarySourceRow[];
		return rows.map(summarySourceFromRow);
	}

	getSummaryParents(summaryId: number): number[] {
		const rows = this.db
			.prepare(
				"SELECT parent_summary_id FROM lcm_summary_parents WHERE summary_id = ? ORDER BY ord, parent_summary_id",
			)
			.all(summaryId) as { parent_summary_id: number }[];
		return rows.map((row) => row.parent_summary_id);
	}

	getSummaryChildren(summaryId: number): number[] {
		const rows = this.db
			.prepare("SELECT summary_id FROM lcm_summary_parents WHERE parent_summary_id = ? ORDER BY ord, summary_id")
			.all(summaryId) as { summary_id: number }[];
		return rows.map((row) => row.summary_id);
	}

	replaceContextItems(sessionKey: string, items: LcmContextItemInput[]): void {
		const run = () => {
			this.db.prepare("DELETE FROM lcm_context_items WHERE session_key = ?").run(sessionKey);
			const insert = this.db.prepare(
				`INSERT INTO lcm_context_items (
					session_key, ordinal, item_type, record_id, summary_id, fingerprint, happened_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const [ordinal, item] of items.entries()) {
				insert.run(
					sessionKey,
					ordinal,
					item.type,
					item.type === "raw" ? item.recordId : null,
					item.type === "summary" ? item.summaryId : null,
					item.fingerprint,
					item.happenedAt,
				);
			}
		};
		if (this.db.inTransaction) run();
		else this.db.transaction(run).immediate();
	}

	listContextItems(sessionKey: string): StoredLcmContextItem[] {
		const rows = this.db
			.prepare(
				`SELECT session_key, ordinal, item_type, record_id, summary_id, fingerprint, happened_at, updated_at
				 FROM lcm_context_items
				 WHERE session_key = ?
				 ORDER BY ordinal ASC`,
			)
			.all(sessionKey) as LcmContextItemRow[];
		return rows.map(contextItemFromRow);
	}

	clearContextItems(sessionKey: string): void {
		this.db.prepare("DELETE FROM lcm_context_items WHERE session_key = ?").run(sessionKey);
	}

	getSessionState(sessionKey: string): StoredLcmSessionState | null {
		const row = this.db
			.prepare(
				"SELECT session_key, compaction_debt, cache_touched_at, updated_at FROM lcm_session_state WHERE session_key = ?",
			)
			.get(sessionKey) as LcmSessionStateRow | undefined;
		return row ? sessionStateFromRow(row) : null;
	}

	upsertSessionState(input: {
		sessionKey: string;
		compactionDebt: number;
		cacheTouchedAt: number | null;
		updatedAt?: number | null;
	}): void {
		const compactionDebt = Math.max(0, Math.floor(input.compactionDebt));
		this.db
			.prepare(
				`INSERT INTO lcm_session_state (session_key, compaction_debt, cache_touched_at, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(session_key) DO UPDATE SET
					compaction_debt = excluded.compaction_debt,
					cache_touched_at = excluded.cache_touched_at,
					updated_at = excluded.updated_at`,
			)
			.run(
				input.sessionKey,
				compactionDebt,
				input.cacheTouchedAt,
				input.updatedAt ?? input.cacheTouchedAt ?? Date.now(),
			);
	}

	clearSessionState(sessionKey: string): void {
		this.db.prepare("DELETE FROM lcm_session_state WHERE session_key = ?").run(sessionKey);
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

		const runRetention = () => {
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
					this.snapshotSummariesForPrunedChildren(segmentId, retainDepth);
					const summaries = this.db
						.prepare("SELECT id FROM lcm_summaries WHERE segment_id = ? AND pinned = 0 AND depth < ?")
						.all(segmentId, retainDepth) as { id: number }[];
					for (const summary of summaries) {
						report.indexDeletes.push({ corpus: "lcm_summary", sourceId: lcmSummaryIndexSourceId(summary.id) });
					}
					report.summaryFtsRowsDeleted += this.db
						.prepare(
							`DELETE FROM lcm_summaries_fts
							 WHERE rowid IN (
								SELECT id FROM lcm_summaries
								WHERE segment_id = ? AND pinned = 0 AND depth < ?
							 )`,
						)
						.run(segmentId, retainDepth).changes;
					report.summariesDeleted += this.db
						.prepare("DELETE FROM lcm_summaries WHERE segment_id = ? AND pinned = 0 AND depth < ?")
						.run(segmentId, retainDepth).changes;
					// lcm_summary_parents rows for pruned summaries are removed by ON DELETE CASCADE.
				}

				this.snapshotSummariesForPrunedRecords(segmentId);

				const records = this.db.prepare("SELECT id FROM lcm_records WHERE segment_id = ?").all(segmentId) as {
					id: number;
				}[];
				for (const record of records) {
					report.indexDeletes.push({ corpus: "lcm_record", sourceId: lcmRecordIndexSourceId(record.id) });
				}
				report.recordFtsRowsDeleted += this.db
					.prepare("DELETE FROM lcm_records_fts WHERE rowid IN (SELECT id FROM lcm_records WHERE segment_id = ?)")
					.run(segmentId).changes;
				report.rawRecordsDeleted += this.db
					.prepare("DELETE FROM lcm_records WHERE segment_id = ?")
					.run(segmentId).changes;
				this.db
					.prepare("UPDATE lcm_segments SET raw_pruned_at = ?, updated_at = unixepoch() WHERE id = ?")
					.run(new Date().toISOString(), segmentId);
			}
		};
		if (this.db.inTransaction) runRetention();
		else this.db.transaction(runRetention).immediate();

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
			// source_summary_id is legacy advisory lineage only. The canonical
			// parent edge is lcm_summary_parents, and this column is scheduled for removal.
			insert.run(
				summaryId,
				index,
				source.recordId ?? null,
				null,
				source.sourceRef ?? null,
				jsonOrNull(source.snapshot ?? null),
			);
		}
	}

	private insertSummaryParents(summaryId: number, parents: number[]): void {
		if (parents.length === 0) return;
		const uniqueParents = dedupeNumbers(parents);
		const existingRows = this.db
			.prepare(`SELECT id FROM lcm_summaries WHERE id IN (${uniqueParents.map(() => "?").join(",")})`)
			.all(...uniqueParents) as { id: number }[];
		const existing = new Set(existingRows.map((row) => row.id));
		const missing = uniqueParents.filter((id) => !existing.has(id));
		if (missing.length > 0) throw new Error(`LCM summary parent does not exist: ${missing.join(", ")}`);
		const insert = this.db.prepare(
			`INSERT INTO lcm_summary_parents (summary_id, parent_summary_id, ord)
			 VALUES (?, ?, ?)`,
		);
		for (const [index, parentId] of uniqueParents.entries()) insert.run(summaryId, parentId, index);
	}

	private summaryParentMap(summaryIds: number[]): Map<number, number[]> {
		const map = new Map<number, number[]>();
		if (summaryIds.length === 0) return map;
		const rows = this.db
			.prepare(
				`SELECT summary_id, parent_summary_id
				 FROM lcm_summary_parents
				 WHERE summary_id IN (${summaryIds.map(() => "?").join(",")})
				 ORDER BY summary_id, ord, parent_summary_id`,
			)
			.all(...summaryIds) as { summary_id: number; parent_summary_id: number }[];
		for (const row of rows) {
			const parents = map.get(row.summary_id) ?? [];
			parents.push(row.parent_summary_id);
			map.set(row.summary_id, parents);
		}
		return map;
	}

	private snapshotSummariesForPrunedRecords(segmentId: string): void {
		const summaries = this.db
			.prepare(
				`SELECT * FROM lcm_summaries
				 WHERE segment_id = ?
				   AND covers_from_record_id IS NOT NULL
				   AND covers_to_record_id IS NOT NULL
				   AND snapshot_json IS NULL
				   AND EXISTS (
				    SELECT 1 FROM lcm_records r
				    WHERE r.segment_id = lcm_summaries.segment_id
				      AND r.id BETWEEN lcm_summaries.covers_from_record_id AND lcm_summaries.covers_to_record_id
				   )
				 ORDER BY depth, id`,
			)
			.all(segmentId) as LcmSummaryRow[];
		const update = this.db.prepare(
			"UPDATE lcm_summaries SET snapshot_json = ?, updated_at = unixepoch() WHERE id = ?",
		);
		for (const summary of summaries) {
			update.run(jsonOrNull(buildSummarySnapshot(this.db, summary)), summary.id);
		}
	}

	private snapshotSummariesForPrunedChildren(segmentId: string, retainDepth: number): void {
		const rows = this.db
			.prepare(
				`SELECT * FROM lcm_summaries
				 WHERE segment_id = ?
				   AND pinned = 0
				   AND depth >= ?
				 ORDER BY depth DESC, id`,
			)
			.all(segmentId, retainDepth) as LcmSummaryRow[];
		const update = this.db.prepare(
			"UPDATE lcm_summaries SET snapshot_json = ?, updated_at = unixepoch() WHERE id = ?",
		);
		for (const row of rows) {
			const snapshot = buildSummaryParentSnapshot(this.db, row.id, new Set<number>());
			if (snapshot.parents.length === 0) continue;
			update.run(jsonOrNull(snapshot.parents), row.id);
		}
	}
}

export function lcmRecordIndexSourceId(id: number): string {
	return `lcm_record:${id}`;
}

export function lcmSummaryIndexSourceId(id: number): string {
	return `lcm_summary:${id}`;
}

export function computeLcmRecordKey(input: LcmRecordInput): string {
	const text = (input.text ?? "").trim();
	if (!text && input.kind !== "boundary") throw new Error("LCM record text must not be empty");
	const parts = input.parts?.length ? input.parts : null;
	return stableHash({
		segmentId: input.segmentId,
		kind: input.kind,
		text: text || "Session boundary",
		parts,
		happenedAt: input.happenedAt ?? new Date().toISOString(),
		source: normalizeSource(input.source),
	});
}

function normalizeRecordInput(input: LcmRecordInput): NormalizedRecordInput {
	const text = (input.text ?? "").trim();
	if (!text && input.kind !== "boundary") throw new Error("LCM record text must not be empty");
	const source = normalizeSource(input.source);
	const happenedAt = input.happenedAt ?? new Date().toISOString();
	const parts = input.parts?.length ? input.parts : null;
	const normalizedText = text || "Session boundary";
	return {
		segmentId: input.segmentId,
		kind: input.kind,
		text: normalizedText,
		parts,
		happenedAt,
		sessionId: input.sessionId ?? null,
		channelKey: input.channelKey ?? null,
		channelId: input.channelId ?? null,
		jobId: input.jobId ?? null,
		source,
		attachments: input.attachments?.length ? input.attachments : null,
		metadata: input.metadata ?? null,
		recordKey: computeLcmRecordKey({ ...input, happenedAt }),
	};
}

function insertRecordPrepared(db: Database.Database, normalized: NormalizedRecordInput): LcmRecordRow {
	const inserted = db
		.prepare(
			`INSERT INTO lcm_records (
				record_key, segment_id, kind, text_full, happened_at, session_id, channel_key,
				channel_id, job_id, source_type, source_path, source_line, source_record_id,
				source_message_id, source_ref, attachments_json, metadata_json, parts_json
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			jsonOrNull(normalized.parts),
		);
	const id = Number(inserted.lastInsertRowid);
	if (normalized.kind !== "boundary") {
		db.prepare("INSERT INTO lcm_records_fts(rowid, text_full) VALUES (?, ?)").run(id, normalized.text);
	}
	const row = db.prepare("SELECT * FROM lcm_records WHERE id = ?").get(id) as LcmRecordRow | undefined;
	if (!row) throw new Error(`Failed to read inserted LCM record: ${id}`);
	return row;
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
		parents: input.parents ?? [],
		metadata: input.metadata ?? null,
		summaryKey: stableHash({
			segmentId: input.segmentId,
			depth: input.depth,
			status,
			text: normalizedText,
			coversFromRecordId: input.coversFromRecordId ?? null,
			coversToRecordId: input.coversToRecordId ?? null,
			source,
			parents: input.parents ?? [],
		}),
	};
}

function insertSummaryPrepared(
	db: Database.Database,
	normalized: NormalizedSummaryInput,
	insertEdges: (summaryId: number, sources: LcmSummarySourceInput[], parents: number[]) => void,
): number {
	const inserted = db
		.prepare(
			`INSERT INTO lcm_summaries (
				summary_key, segment_id, depth, status, text_full, pinned,
				covers_from_record_id, covers_to_record_id, snapshot_json, source_type, source_path,
				source_line, source_record_id, source_message_id, source_ref, metadata_json
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			null,
			normalized.source.sourceType,
			normalized.source.sourcePath ?? null,
			normalized.source.sourceLine ?? null,
			sourceRecordIdToString(normalized.source.sourceRecordId),
			normalized.source.sourceMessageId ?? null,
			normalized.source.sourceRef ?? null,
			jsonOrNull(normalized.metadata),
		);
	const id = Number(inserted.lastInsertRowid);
	db.prepare("INSERT INTO lcm_summaries_fts(rowid, text_full) VALUES (?, ?)").run(id, normalized.text);
	insertEdges(id, normalized.sourceItems, normalized.parents);
	return id;
}

function runSummaryInsertTransaction(
	store: LcmStore,
	normalized: NormalizedSummaryInput,
	insertEdges: (summaryId: number, sources: LcmSummarySourceInput[], parents: number[]) => void,
): number {
	store.ensureSegment({ id: normalized.segmentId });
	const existing = store.db.prepare("SELECT id FROM lcm_summaries WHERE summary_key = ?").get(normalized.summaryKey) as
		| { id: number }
		| undefined;
	if (existing) return existing.id;
	return insertSummaryPrepared(store.db, normalized, insertEdges);
}

function dedupeNumbers(values: readonly number[]): number[] {
	const seen = new Set<number>();
	const result: number[] = [];
	for (const value of values) {
		if (!Number.isInteger(value) || value <= 0) throw new Error("LCM summary parents must be positive integer ids");
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
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
		parts: parseJsonArray<LcmRecordPart>(row.parts_json),
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

function summaryFromRow(row: LcmSummaryRow, parents: number[] = []): StoredLcmSummary {
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
		snapshot: parseJsonArray(row.snapshot_json) as LcmSummarySnapshot | null,
		parents,
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

function contextItemFromRow(row: LcmContextItemRow): StoredLcmContextItem {
	if (row.item_type === "raw") {
		if (row.record_id === null) throw new Error(`Invalid raw LCM context item at ordinal ${row.ordinal}`);
		return {
			sessionKey: row.session_key,
			ordinal: row.ordinal,
			type: "raw",
			recordId: row.record_id,
			summaryId: null,
			fingerprint: row.fingerprint,
			happenedAt: row.happened_at,
			updatedAt: row.updated_at,
		};
	}
	if (row.item_type === "summary") {
		if (row.summary_id === null) throw new Error(`Invalid summary LCM context item at ordinal ${row.ordinal}`);
		return {
			sessionKey: row.session_key,
			ordinal: row.ordinal,
			type: "summary",
			recordId: null,
			summaryId: row.summary_id,
			fingerprint: row.fingerprint,
			happenedAt: row.happened_at,
			updatedAt: row.updated_at,
		};
	}
	throw new Error(`Unknown LCM context item type: ${row.item_type}`);
}

function sessionStateFromRow(row: LcmSessionStateRow): StoredLcmSessionState {
	return {
		sessionKey: row.session_key,
		compactionDebt: row.compaction_debt,
		cacheTouchedAt: row.cache_touched_at,
		updatedAt: row.updated_at,
	};
}

const SUMMARY_SNAPSHOT_TEXT_LIMIT = 4 * 1024;
const SUMMARY_SNAPSHOT_TRUNCATED_SUFFIX = "…[truncated]";

function buildSummarySnapshot(db: Database.Database, summary: LcmSummaryRow): LcmSummarySnapshot {
	const rows = db
		.prepare(
			`SELECT * FROM lcm_records
			 WHERE segment_id = ?
			   AND id BETWEEN ? AND ?
			 ORDER BY happened_at, id`,
		)
		.all(summary.segment_id, summary.covers_from_record_id, summary.covers_to_record_id) as LcmRecordRow[];
	return rows.map(snapshotRecordFromRow);
}

function buildSummaryParentSnapshot(
	db: Database.Database,
	summaryId: number,
	visiting: Set<number>,
): LcmSummaryParentSnapshot {
	if (visiting.has(summaryId)) throw new Error(`Cycle detected in LCM summary parents at ${summaryId}`);
	visiting.add(summaryId);
	const row = db.prepare("SELECT * FROM lcm_summaries WHERE id = ?").get(summaryId) as LcmSummaryRow | undefined;
	if (!row) throw new Error(`LCM summary does not exist: ${summaryId}`);
	let snapshot = parseJsonArray<LcmSummarySnapshot[number]>(row.snapshot_json) as LcmSummarySnapshot | null;
	if (
		!snapshot &&
		row.covers_from_record_id !== null &&
		row.covers_to_record_id !== null &&
		db
			.prepare("SELECT 1 FROM lcm_records WHERE segment_id = ? AND id BETWEEN ? AND ? LIMIT 1")
			.get(row.segment_id, row.covers_from_record_id, row.covers_to_record_id)
	) {
		snapshot = buildSummarySnapshot(db, row);
	}
	const parentRows = db
		.prepare(
			`SELECT parent_summary_id
			 FROM lcm_summary_parents
			 WHERE summary_id = ?
			 ORDER BY ord, parent_summary_id`,
		)
		.all(summaryId) as { parent_summary_id: number }[];
	const parents = parentRows.map((parent) => buildSummaryParentSnapshot(db, parent.parent_summary_id, visiting));
	visiting.delete(summaryId);
	return {
		summaryId: row.id,
		depth: row.depth,
		text: row.text_full,
		coversFromRecordId: row.covers_from_record_id,
		coversToRecordId: row.covers_to_record_id,
		snapshot,
		parents,
	};
}

function snapshotRecordFromRow(row: LcmRecordRow): LcmSummarySnapshot[number] {
	const metadata = parseJsonObject(row.metadata_json);
	return {
		id: row.id,
		kind: row.kind as LcmRecordKind,
		happened_at: row.happened_at,
		role: snapshotRole(row.kind as LcmRecordKind, metadata),
		text: truncateSummarySnapshotText(row.text_full),
		parts: parseJsonArray<LcmRecordPart>(row.parts_json),
		attachments: parseJsonArray(row.attachments_json),
	};
}

function snapshotRole(kind: LcmRecordKind, metadata: Record<string, unknown> | null): string | null {
	if (typeof metadata?.role === "string" && metadata.role.trim()) return metadata.role;
	if (kind === "user" || kind === "assistant") return kind;
	if (kind === "tool") return "tool";
	return null;
}

function truncateSummarySnapshotText(text: string): string {
	if (text.length <= SUMMARY_SNAPSHOT_TEXT_LIMIT) return text;
	const retainedLength = Math.max(0, SUMMARY_SNAPSHOT_TEXT_LIMIT - SUMMARY_SNAPSHOT_TRUNCATED_SUFFIX.length);
	return `${text.slice(0, retainedLength)}${SUMMARY_SNAPSHOT_TRUNCATED_SUFFIX}`;
}

interface NormalizedRecordInput {
	recordKey: string;
	segmentId: string;
	kind: LcmRecordKind;
	text: string;
	parts: LcmRecordPart[] | null;
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
	parents: number[];
	metadata: Record<string, unknown> | null;
}
