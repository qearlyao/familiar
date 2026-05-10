import type Database from "better-sqlite3";

export interface MemoryIndexMigrationOptions {
	embeddingProvider: string;
	embeddingModel: string;
	embeddingDimensions: number;
}

const SCHEMA_VERSION = 1;

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
			source_id TEXT,
			source_ref TEXT,
			chunk_index INTEGER NOT NULL DEFAULT 0,
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

		CREATE INDEX IF NOT EXISTS idx_memory_chunks_source ON memory_chunks(corpus, source_id);
		CREATE INDEX IF NOT EXISTS idx_memory_chunks_hash ON memory_chunks(content_hash);
		CREATE INDEX IF NOT EXISTS idx_memory_chunks_model ON memory_chunks(embedding_model, embedding_dimensions);

		CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
			text_full,
			snippet,
			content='memory_chunks',
			content_rowid='id'
		);
	`);

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
			db.prepare("DELETE FROM memory_chunks").run();
		}).immediate();
	}
}
