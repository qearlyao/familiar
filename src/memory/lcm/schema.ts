import type Database from "better-sqlite3";

const SCHEMA_VERSION = 9;

export function runLcmMigrations(db: Database.Database): void {
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	const run = () => {
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
				parts_json TEXT,
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
				snapshot_json TEXT,
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

			CREATE TABLE IF NOT EXISTS lcm_summary_sources (
				summary_id INTEGER NOT NULL REFERENCES lcm_summaries(id) ON DELETE CASCADE,
				ord INTEGER NOT NULL,
				record_id INTEGER REFERENCES lcm_records(id) ON DELETE SET NULL,
				-- Advisory legacy edge only. New condensation code must write summary-to-summary
				-- lineage to lcm_summary_parents so parent coverage survives source-row drift.
				source_summary_id INTEGER REFERENCES lcm_summaries(id) ON DELETE SET NULL,
				source_ref TEXT,
				snapshot_json TEXT,
				PRIMARY KEY(summary_id, ord)
			);

			CREATE TABLE IF NOT EXISTS lcm_summary_parents (
				summary_id INTEGER NOT NULL REFERENCES lcm_summaries(id) ON DELETE CASCADE,
				parent_summary_id INTEGER NOT NULL REFERENCES lcm_summaries(id) ON DELETE CASCADE,
				ord INTEGER NOT NULL,
				PRIMARY KEY(summary_id, parent_summary_id)
			);

			CREATE INDEX IF NOT EXISTS idx_summary_parents_parent ON lcm_summary_parents(parent_summary_id);
			CREATE INDEX IF NOT EXISTS idx_summary_parents_child ON lcm_summary_parents(summary_id);

			CREATE TABLE IF NOT EXISTS lcm_context_items (
				session_key TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				summary_id INTEGER NOT NULL REFERENCES lcm_summaries(id) ON DELETE CASCADE,
				fingerprint TEXT NOT NULL,
				happened_at TEXT,
				updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
				PRIMARY KEY(session_key, ordinal)
			);

			CREATE TABLE IF NOT EXISTS lcm_session_state (
				session_key TEXT PRIMARY KEY,
				compaction_debt INTEGER NOT NULL DEFAULT 0,
				cache_touched_at INTEGER,
				updated_at INTEGER
			);
		`);

		migrateRecordPartsColumn(db);
		migrateSummarySnapshotColumn(db);
		migrateContextItemsSummaryOnly(db);
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_lcm_context_items_session ON lcm_context_items(session_key);
			CREATE INDEX IF NOT EXISTS idx_lcm_context_items_summary ON lcm_context_items(summary_id);
			DROP TABLE IF EXISTS lcm_records_fts;
			DROP TABLE IF EXISTS lcm_summaries_fts;
		`);
		writeMeta(db, "schema_version", String(SCHEMA_VERSION));
	};
	if (db.inTransaction) run();
	else db.transaction(run).immediate();
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

function migrateRecordPartsColumn(db: Database.Database): void {
	const columns = db.prepare("PRAGMA table_info(lcm_records)").all() as Array<{ name: string }>;
	if (columns.some((column) => column.name === "parts_json")) return;
	db.prepare("ALTER TABLE lcm_records ADD COLUMN parts_json TEXT").run();
}

function migrateSummarySnapshotColumn(db: Database.Database): void {
	const columns = db.prepare("PRAGMA table_info(lcm_summaries)").all() as Array<{ name: string }>;
	if (columns.some((column) => column.name === "snapshot_json")) return;
	db.prepare("ALTER TABLE lcm_summaries ADD COLUMN snapshot_json TEXT").run();
}

function migrateContextItemsSummaryOnly(db: Database.Database): void {
	const columns = db.prepare("PRAGMA table_info(lcm_context_items)").all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "item_type" || column.name === "record_id")) return;
	db.exec(`
		CREATE TABLE lcm_context_items_next (
			session_key TEXT NOT NULL,
			ordinal INTEGER NOT NULL,
			summary_id INTEGER NOT NULL REFERENCES lcm_summaries(id) ON DELETE CASCADE,
			fingerprint TEXT NOT NULL,
			happened_at TEXT,
			updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
			PRIMARY KEY(session_key, ordinal)
		);
		INSERT INTO lcm_context_items_next (
			session_key, ordinal, summary_id, fingerprint, happened_at, updated_at
		)
		SELECT item.session_key, item.ordinal, item.summary_id, item.fingerprint, item.happened_at, item.updated_at
		FROM lcm_context_items item
		JOIN lcm_summaries summary ON summary.id = item.summary_id
		WHERE item.item_type = 'summary';
		DROP TABLE lcm_context_items;
		ALTER TABLE lcm_context_items_next RENAME TO lcm_context_items;
	`);
}
