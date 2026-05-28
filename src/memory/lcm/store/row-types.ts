export interface LcmSegmentRow {
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

export interface LcmRecordRow {
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

export interface LcmSummaryRow {
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

export interface LcmSummarySourceRow {
	summary_id: number;
	ord: number;
	record_id: number | null;
	source_summary_id: number | null;
	source_ref: string | null;
	snapshot_json: string | null;
}

export interface LcmContextItemRow {
	session_key: string;
	ordinal: number;
	item_type: string;
	record_id: number | null;
	summary_id: number | null;
	fingerprint: string;
	happened_at: string | null;
	updated_at: number;
}

export interface LcmSessionStateRow {
	session_key: string;
	compaction_debt: number;
	cache_touched_at: number | null;
	updated_at: number | null;
}
