import type Database from "better-sqlite3";

import { loadSqliteVec, type VectorCapability } from "./vec.js";

export interface MemoryIndexMigrationOptions {
	embeddingProvider: string;
	embeddingModel: string;
	embeddingDimensions: number;
}

const SCHEMA_VERSION = 3;

export function runMemoryIndexMigrations(db: Database.Database, options: MemoryIndexMigrationOptions): void {
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	const vec = loadSqliteVec(db);
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
	const vectorCapability = reconcileVectorTable(db, options, vec.available);
	writeMeta(db, "schema_version", String(SCHEMA_VERSION));
	writeMeta(db, "embedding_provider", options.embeddingProvider);
	writeMeta(db, "embedding_model", options.embeddingModel);
	writeMeta(db, "embedding_dimensions", String(options.embeddingDimensions));
	writeMeta(db, "vector_capability", vectorCapability);
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
			db.prepare("DROP TRIGGER IF EXISTS trg_memory_chunks_delete_vec").run();
			db.prepare("DROP TABLE IF EXISTS memory_vec").run();
			db.prepare("DELETE FROM memory_index_sources").run();
			db.prepare("DELETE FROM memory_chunks").run();
			writeMeta(db, "requires_reindex", "1");
		}).immediate();
	}
}

function reconcileVectorTable(
	db: Database.Database,
	options: MemoryIndexMigrationOptions,
	sqliteVecAvailable: boolean,
): VectorCapability {
	const previousCapability = readMeta(db, "vector_capability");
	if (!sqliteVecAvailable) {
		db.prepare("DROP TRIGGER IF EXISTS trg_memory_chunks_delete_vec").run();
		return "blob-js";
	}
	try {
		db.transaction(() => {
			const hadVectorTable = tableExists(db, "memory_vec");
			if (!hadVectorTable) {
				db.prepare(
					`CREATE VIRTUAL TABLE memory_vec USING vec0(
						embedding float[${options.embeddingDimensions}] distance_metric=cosine
					)`,
				).run();
			}
			if (previousCapability === "blob-js") {
				db.prepare("DELETE FROM memory_vec").run();
				db.prepare("INSERT INTO memory_vec(rowid, embedding) SELECT id, embedding FROM memory_chunks").run();
			}
			// Virtual tables cannot own FK constraints, so this mirrors ON DELETE
			// CASCADE for direct memory_chunks deletes while sqlite-vec is loaded.
			db.prepare(
				`CREATE TRIGGER IF NOT EXISTS trg_memory_chunks_delete_vec
				 AFTER DELETE ON memory_chunks
				 BEGIN
					DELETE FROM memory_vec WHERE rowid = old.id;
				 END`,
			).run();
		}).immediate();
		return "sqlite-vec";
	} catch {
		db.prepare("DROP TRIGGER IF EXISTS trg_memory_chunks_delete_vec").run();
		return "blob-js";
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

function tableExists(db: Database.Database, name: string): boolean {
	const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
		| { ok: number }
		| undefined;
	return !!row;
}
