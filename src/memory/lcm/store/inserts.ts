import type Database from "better-sqlite3";

import type { LcmSummarySourceInput } from "../types.js";
import type { NormalizedRecordInput, NormalizedSummaryInput } from "./normalizers.js";
import type { LcmRecordRow } from "./row-types.js";
import { jsonOrNull, sourceRecordIdToString } from "./serialization.js";

export function insertRecordPrepared(db: Database.Database, normalized: NormalizedRecordInput): LcmRecordRow {
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

export function insertSummaryPrepared(
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
