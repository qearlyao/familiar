import type Database from "better-sqlite3";

const SCHEMA_VERSION = 1;

export function runLcmMigrations(db: Database.Database): void {
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.exec(`
		CREATE TABLE IF NOT EXISTS lcm_meta (
			k TEXT PRIMARY KEY,
			v TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS lcm_segments (
			id TEXT PRIMARY KEY,
			status TEXT NOT NULL DEFAULT 'active',
			session_id TEXT,
			channel_key TEXT,
			started_at TEXT NOT NULL,
			closed_at TEXT,
			raw_pruned_at TEXT,
			boundary_source_json TEXT,
			metadata_json TEXT,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		);

		CREATE TABLE IF NOT EXISTS lcm_records (
			id INTEGER PRIMARY KEY,
			record_key TEXT NOT NULL UNIQUE,
			segment_id TEXT NOT NULL REFERENCES lcm_segments(id) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			text_full TEXT NOT NULL,
			happened_at TEXT NOT NULL,
			session_id TEXT,
			channel_key TEXT,
			channel_id TEXT,
			job_id TEXT,
			source_type TEXT NOT NULL,
			source_path TEXT,
			source_line INTEGER,
			source_record_id TEXT,
			source_message_id TEXT,
			source_ref TEXT,
			attachments_json TEXT,
			metadata_json TEXT,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		);

		CREATE INDEX IF NOT EXISTS idx_lcm_records_segment ON lcm_records(segment_id, happened_at, id);
		CREATE INDEX IF NOT EXISTS idx_lcm_records_source ON lcm_records(source_type, source_path, source_record_id);
		CREATE INDEX IF NOT EXISTS idx_lcm_records_session ON lcm_records(session_id, channel_key, happened_at);

		CREATE VIRTUAL TABLE IF NOT EXISTS lcm_records_fts USING fts5(
			text_full,
			content='lcm_records',
			content_rowid='id'
		);

		CREATE TABLE IF NOT EXISTS lcm_summaries (
			id INTEGER PRIMARY KEY,
			summary_key TEXT NOT NULL UNIQUE,
			segment_id TEXT NOT NULL REFERENCES lcm_segments(id) ON DELETE CASCADE,
			depth INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'placeholder',
			text_full TEXT NOT NULL,
			pinned INTEGER NOT NULL DEFAULT 0,
			covers_from_record_id INTEGER REFERENCES lcm_records(id) ON DELETE SET NULL,
			covers_to_record_id INTEGER REFERENCES lcm_records(id) ON DELETE SET NULL,
			source_type TEXT NOT NULL,
			source_path TEXT,
			source_line INTEGER,
			source_record_id TEXT,
			source_message_id TEXT,
			source_ref TEXT,
			metadata_json TEXT,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		);

		CREATE INDEX IF NOT EXISTS idx_lcm_summaries_segment ON lcm_summaries(segment_id, depth, id);
		CREATE INDEX IF NOT EXISTS idx_lcm_summaries_status ON lcm_summaries(status, pinned);

		CREATE VIRTUAL TABLE IF NOT EXISTS lcm_summaries_fts USING fts5(
			text_full,
			content='lcm_summaries',
			content_rowid='id'
		);

		CREATE TABLE IF NOT EXISTS lcm_summary_sources (
			summary_id INTEGER NOT NULL REFERENCES lcm_summaries(id) ON DELETE CASCADE,
			ord INTEGER NOT NULL,
			record_id INTEGER REFERENCES lcm_records(id) ON DELETE SET NULL,
			source_summary_id INTEGER REFERENCES lcm_summaries(id) ON DELETE SET NULL,
			source_ref TEXT,
			snapshot_json TEXT,
			PRIMARY KEY(summary_id, ord)
		);
	`);

	writeMeta(db, "schema_version", String(SCHEMA_VERSION));
}

export function readMeta(db: Database.Database, key: string): string | null {
	const row = db.prepare("SELECT v FROM lcm_meta WHERE k = ?").get(key) as { v: string } | undefined;
	return row?.v ?? null;
}

export function writeMeta(db: Database.Database, key: string, value: string): void {
	db.prepare(
		`INSERT INTO lcm_meta(k, v) VALUES (?, ?)
		 ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
	).run(key, value);
}
