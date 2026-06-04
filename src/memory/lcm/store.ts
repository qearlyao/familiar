import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import type { Config } from "../../config/index.js";
import { normalizeFtsMatchQuery } from "../index/fts-query.js";
import { runInTransaction } from "../util.js";
import { readMeta, runLcmMigrations } from "./schema.js";
import { lcmRecordIndexSourceId, lcmSummaryIndexSourceId } from "./store/index-ids.js";
import { insertRecordPrepared, insertSummaryPrepared } from "./store/inserts.js";
import {
	computeLcmRecordKey,
	dedupeSummaryParentIds,
	type NormalizedSummaryInput,
	normalizeRecordInput,
	normalizeSummaryInput,
} from "./store/normalizers.js";
import {
	contextItemFromRow,
	recordFromRow,
	segmentFromRow,
	sessionStateFromRow,
	summaryFromRow,
	summarySourceFromRow,
} from "./store/row-mappers.js";
import type {
	LcmContextItemRow,
	LcmRecordRow,
	LcmSegmentRow,
	LcmSessionStateRow,
	LcmSummaryRow,
	LcmSummarySourceRow,
} from "./store/row-types.js";
import { jsonOrNull } from "./store/serialization.js";
import { buildSummaryParentSnapshot, buildSummarySnapshot } from "./store/snapshots.js";
import type {
	LcmContextItemInput,
	LcmRecordInput,
	LcmRetentionOptions,
	LcmRetentionReport,
	LcmSegmentInput,
	LcmSummaryInput,
	LcmSummarySourceInput,
	StoredLcmContextItem,
	StoredLcmRecord,
	StoredLcmSegment,
	StoredLcmSessionState,
	StoredLcmSummary,
	StoredLcmSummarySource,
} from "./types.js";

export { lcmRecordIndexSourceId, lcmSummaryIndexSourceId } from "./store/index-ids.js";
export { computeLcmRecordKey } from "./store/normalizers.js";

interface StoreOptions {
	path?: string;
	db?: Database.Database;
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
		return runInTransaction(this.db, runInsert);
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
			this.runSummaryInsertTransaction(normalized, (id, sources, parents) => {
				this.insertSummarySources(id, sources);
				this.insertSummaryParents(id, parents);
			});
		const result = runInTransaction(this.db, runInsert);
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
			// source_summary_id is advisory only; the canonical parent edge is lcm_summary_parents.
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
		const uniqueParents = dedupeSummaryParentIds(parents);
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

	private runSummaryInsertTransaction(
		normalized: NormalizedSummaryInput,
		insertEdges: (summaryId: number, sources: LcmSummarySourceInput[], parents: number[]) => void,
	): number {
		this.ensureSegment({ id: normalized.segmentId });
		const existing = this.db
			.prepare("SELECT id FROM lcm_summaries WHERE summary_key = ?")
			.get(normalized.summaryKey) as { id: number } | undefined;
		if (existing) return existing.id;
		return insertSummaryPrepared(this.db, normalized, insertEdges);
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
