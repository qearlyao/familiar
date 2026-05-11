import type Database from "better-sqlite3";

export interface MemoryIndexMigrationOptions {
	embeddingProvider: string;
	embeddingModel: string;
	embeddingDimensions: number;
}

const SCHEMA_VERSION = 2;

export function runMemoryIndexMigrations(db: Database.Database, options: MemoryIndexMigrationOptions): void {
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_meta (
			k TEXT PRIMARY KEY,
			v TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS memory_chunks (
			id INTEGER PRIMARY KEY,
			content_hash TEXT NOT NULL UNIQUE,
			corpus TEXT NOT NULL,
			text_full TEXT NOT NULL,
			snippet TEXT NOT NULL,
			token_count INTEGER,
			metadata_json TEXT,
			embedding_model TEXT NOT NULL,
			embedding_dimensions INTEGER NOT NULL,
			embedding BLOB NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		);

		CREATE INDEX IF NOT EXISTS idx_memory_chunks_hash ON memory_chunks(content_hash);
		CREATE INDEX IF NOT EXISTS idx_memory_chunks_model ON memory_chunks(embedding_model, embedding_dimensions);

		CREATE TABLE IF NOT EXISTS memory_index_sources (
			chunk_id INTEGER NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
			corpus TEXT NOT NULL,
			source_id TEXT NOT NULL,
			source_ref TEXT,
			chunk_index INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY(corpus, source_id, chunk_index)
		);

		CREATE INDEX IF NOT EXISTS idx_memory_index_sources_chunk ON memory_index_sources(chunk_id);

		-- Contentless FTS avoids SQLite maintaining shadow copies or stale external-content rows.
		CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
			text_full,
			snippet,
			content='',
			contentless_delete=1
		);
	`);

	migrateMemoryIndexSources(db);
	reconcileEmbeddingConfig(db, options);
	writeMeta(db, "schema_version", String(SCHEMA_VERSION));
	writeMeta(db, "embedding_provider", options.embeddingProvider);
	writeMeta(db, "embedding_model", options.embeddingModel);
	writeMeta(db, "embedding_dimensions", String(options.embeddingDimensions));
	writeMeta(db, "vector_capability", "blob-js");
}

export function readMeta(db: Database.Database, key: string): string | null {
	const row = db.prepare("SELECT v FROM memory_meta WHERE k = ?").get(key) as { v: string } | undefined;
	return row?.v ?? null;
}

export function writeMeta(db: Database.Database, key: string, value: string): void {
	db.prepare(
		`INSERT INTO memory_meta(k, v) VALUES (?, ?)
		 ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
	).run(key, value);
}

function reconcileEmbeddingConfig(db: Database.Database, options: MemoryIndexMigrationOptions): void {
	const model = readMeta(db, "embedding_model");
	const dimensions = readMeta(db, "embedding_dimensions");
	if (
		(model && model !== options.embeddingModel) ||
		(dimensions && dimensions !== String(options.embeddingDimensions))
	) {
		db.transaction(() => {
			db.prepare("DELETE FROM memory_fts").run();
			db.prepare("DELETE FROM memory_index_sources").run();
			db.prepare("DELETE FROM memory_chunks").run();
		}).immediate();
	}
}

function migrateMemoryIndexSources(db: Database.Database): void {
	const columns = db.prepare("PRAGMA table_info(memory_chunks)").all() as { name: string }[];
	const hasSourceColumns = columns.some((column) => column.name === "source_id");
	if (hasSourceColumns) {
		db.transaction(() => {
			db.prepare(
				`INSERT OR IGNORE INTO memory_index_sources(chunk_id, corpus, source_id, source_ref, chunk_index)
				 SELECT id, corpus, source_id, source_ref, chunk_index
				 FROM memory_chunks
				 WHERE source_id IS NOT NULL`,
			).run();
		}).immediate();
	}

	const ftsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'").get() as
		| { sql: string }
		| undefined;
	if (ftsSql && (ftsSql.sql.includes("content='memory_chunks'") || !ftsSql.sql.includes("contentless_delete=1"))) {
		db.transaction(() => {
			db.prepare("DROP TABLE memory_fts").run();
			db.prepare(
				`CREATE VIRTUAL TABLE memory_fts USING fts5(
					text_full,
					snippet,
					content='',
					contentless_delete=1
				)`,
			).run();
			const rows = db.prepare("SELECT id, text_full, snippet FROM memory_chunks").all() as {
				id: number;
				text_full: string;
				snippet: string;
			}[];
			const insert = db.prepare("INSERT INTO memory_fts(rowid, text_full, snippet) VALUES (?, ?, ?)");
			for (const row of rows) insert.run(row.id, row.text_full, row.snippet);
		}).immediate();
	}
}
