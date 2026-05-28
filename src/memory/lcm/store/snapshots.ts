import type Database from "better-sqlite3";

import type { LcmRecordKind, LcmRecordPart, LcmSummaryParentSnapshot, LcmSummarySnapshot } from "../types.js";
import type { LcmRecordRow, LcmSummaryRow } from "./row-types.js";
import { parseJsonArray, parseJsonObject } from "./serialization.js";

const SUMMARY_SNAPSHOT_TEXT_LIMIT = 4 * 1024;
const SUMMARY_SNAPSHOT_TRUNCATED_SUFFIX = "…[truncated]";

export function buildSummarySnapshot(db: Database.Database, summary: LcmSummaryRow): LcmSummarySnapshot {
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

export function buildSummaryParentSnapshot(
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

export function snapshotRecordFromRow(row: LcmRecordRow): LcmSummarySnapshot[number] {
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

export function snapshotRole(kind: LcmRecordKind, metadata: Record<string, unknown> | null): string | null {
	if (typeof metadata?.role === "string" && metadata.role.trim()) return metadata.role;
	if (kind === "user" || kind === "assistant") return kind;
	if (kind === "tool") return "tool";
	return null;
}

export function truncateSummarySnapshotText(text: string): string {
	if (text.length <= SUMMARY_SNAPSHOT_TEXT_LIMIT) return text;
	const retainedLength = Math.max(0, SUMMARY_SNAPSHOT_TEXT_LIMIT - SUMMARY_SNAPSHOT_TRUNCATED_SUFFIX.length);
	return `${text.slice(0, retainedLength)}${SUMMARY_SNAPSHOT_TRUNCATED_SUFFIX}`;
}
