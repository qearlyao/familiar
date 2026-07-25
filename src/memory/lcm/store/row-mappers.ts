import type {
	LcmRecordKind,
	LcmRecordPart,
	LcmSegmentStatus,
	LcmSourceProvenance,
	LcmSummarySnapshot,
	LcmSummaryStatus,
	StoredLcmContextItem,
	StoredLcmRecord,
	StoredLcmSegment,
	StoredLcmSessionState,
	StoredLcmSummary,
	StoredLcmSummarySource,
} from "../types.js";
import type {
	LcmContextItemRow,
	LcmRecordRow,
	LcmSegmentRow,
	LcmSessionStateRow,
	LcmSummaryRow,
	LcmSummarySourceRow,
} from "./row-types.js";
import { parseJsonArray, parseJsonObject } from "./serialization.js";

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

export function segmentFromRow(row: LcmSegmentRow): StoredLcmSegment {
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

export function recordFromRow(row: LcmRecordRow): StoredLcmRecord {
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

export function summaryFromRow(row: LcmSummaryRow, parents: number[] = []): StoredLcmSummary {
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

export function summarySourceFromRow(row: LcmSummarySourceRow): StoredLcmSummarySource {
	return {
		summaryId: row.summary_id,
		ord: row.ord,
		recordId: row.record_id,
		sourceSummaryId: row.source_summary_id,
		sourceRef: row.source_ref,
		snapshot: parseJsonObject(row.snapshot_json),
	};
}

export function contextItemFromRow(row: LcmContextItemRow): StoredLcmContextItem {
	return {
		sessionKey: row.session_key,
		ordinal: row.ordinal,
		summaryId: row.summary_id,
		fingerprint: row.fingerprint,
		happenedAt: row.happened_at,
		updatedAt: row.updated_at,
	};
}

export function sessionStateFromRow(row: LcmSessionStateRow): StoredLcmSessionState {
	return {
		sessionKey: row.session_key,
		compactionDebt: row.compaction_debt,
		cacheTouchedAt: row.cache_touched_at,
		updatedAt: row.updated_at,
	};
}
