import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import type { Config } from "../../config.js";
import { readMeta, runMemoryIndexMigrations } from "./schema.js";
import { cosineDistance, decodeVector, encodeVector } from "./vector.js";

export interface MemoryChunkInput {
	corpus: string;
	sourceId?: string | null;
	sourceRef?: string | null;
	chunkIndex?: number;
	text: string;
	snippet?: string;
	tokenCount?: number | null;
	metadata?: Record<string, unknown> | null;
	embedding: Float32Array;
}

export interface StoredMemoryChunk {
	id: number;
	contentHash: string;
	corpus: string;
	sourceId: string | null;
	sourceRef: string | null;
	chunkIndex: number;
	text: string;
	snippet: string;
	tokenCount: number | null;
	metadata: Record<string, unknown> | null;
	embeddingModel: string;
	embeddingDimensions: number;
	createdAt: number;
	updatedAt: number;
}

export interface MemorySearchHit {
	id: number;
	score: number;
	chunk: StoredMemoryChunk;
}

export interface MemorySearchOptions {
	limit?: number;
	corpus?: string | undefined;
}

export interface MemoryIndexStats {
	indexed: number;
	ftsRows: number;
	vectorRows: number;
	vectorAvailable: boolean;
	embeddingProvider: string | null;
	embeddingModel: string | null;
	embeddingDimensions: number | null;
	dbSizeBytes: number;
}

export interface MemoryEmbeddingConfig {
	provider: string;
	model: string;
	dimensions: number;
}

interface MemoryChunkRow {
	id: number;
	content_hash: string;
	corpus: string;
	source_id: string | null;
	source_ref: string | null;
	chunk_index: number;
	text_full: string;
	snippet: string;
	token_count: number | null;
	metadata_json: string | null;
	embedding_model: string;
	embedding_dimensions: number;
	embedding: Buffer;
	created_at: number;
	updated_at: number;
}

interface StoreOptions {
	path?: string;
	db?: Database.Database;
	embeddingProvider: string;
	embeddingModel: string;
	embeddingDimensions: number;
}

export class MemoryIndexStore {
	readonly db: Database.Database;
	private readonly ownsDb: boolean;
	private readonly embeddingProvider: string;
	private readonly embeddingModel: string;
	private readonly embeddingDimensions: number;

	constructor(options: StoreOptions) {
		if (!options.db && !options.path) throw new Error("MemoryIndexStore requires a db or path");
		if (options.db) {
			this.db = options.db;
			this.ownsDb = false;
		} else {
			const path = options.path as string;
			mkdirSync(dirname(path), { recursive: true });
			this.db = new Database(path);
			this.ownsDb = true;
		}
		this.embeddingProvider = options.embeddingProvider;
		this.embeddingModel = options.embeddingModel;
		this.embeddingDimensions = options.embeddingDimensions;
		runMemoryIndexMigrations(this.db, {
			embeddingProvider: this.embeddingProvider,
			embeddingModel: this.embeddingModel,
			embeddingDimensions: this.embeddingDimensions,
		});
	}

	static open(config: Config): MemoryIndexStore {
		return new MemoryIndexStore({
			path: resolve(config.memory.indexDir, "memory.sqlite"),
			embeddingProvider: config.memory.embedding.provider,
			embeddingModel: config.memory.embedding.model,
			embeddingDimensions: config.memory.embedding.dimensions,
		});
	}

	close(): void {
		if (this.ownsDb) this.db.close();
	}

	embeddingConfig(): MemoryEmbeddingConfig {
		return {
			provider: this.embeddingProvider,
			model: this.embeddingModel,
			dimensions: this.embeddingDimensions,
		};
	}

	insertChunk(input: MemoryChunkInput): number {
		return this.insertChunks([input])[0] as number;
	}

	insertChunks(inputs: MemoryChunkInput[]): number[] {
		if (inputs.length === 0) return [];
		const rows = inputs.map((input) => this.normalizeInput(input));
		const out: number[] = [];
		const insert = this.db.transaction((items: NormalizedChunkInput[]) => {
			for (const item of items) out.push(this.insertNormalized(item));
		});
		insert.immediate(rows);
		return out;
	}

	replaceSource(corpus: string, sourceId: string, inputs: MemoryChunkInput[]): number[] {
		const rows = inputs.map((input) => this.normalizeInput({ ...input, corpus, sourceId }));
		const out: number[] = [];
		const replace = this.db.transaction(() => {
			this.deleteBySourceInternal(corpus, sourceId);
			for (const item of rows) out.push(this.insertNormalized(item));
		});
		replace.immediate();
		return out;
	}

	whichHashesPresent(hashes: string[]): Map<string, number> {
		const present = new Map<string, number>();
		if (hashes.length === 0) return present;
		const chunkSize = 256;
		for (let index = 0; index < hashes.length; index += chunkSize) {
			const chunk = hashes.slice(index, index + chunkSize);
			const placeholders = chunk.map(() => "?").join(",");
			const rows = this.db
				.prepare(`SELECT content_hash, id FROM memory_chunks WHERE content_hash IN (${placeholders})`)
				.all(...chunk) as { content_hash: string; id: number }[];
			for (const row of rows) present.set(row.content_hash, row.id);
		}
		return present;
	}

	getChunk(id: number): StoredMemoryChunk | null {
		const row = this.db.prepare("SELECT * FROM memory_chunks WHERE id = ?").get(id) as MemoryChunkRow | undefined;
		return row ? rowToChunk(row) : null;
	}

	searchLexical(query: string, options: number | MemorySearchOptions = {}): MemorySearchHit[] {
		const normalized = normalizeSearchOptions(options);
		const matchQuery = normalizeFtsMatchQuery(query);
		if (!matchQuery) return [];
		const params: unknown[] = [matchQuery];
		const corpusFilter = normalized.corpus ? "AND c.corpus = ?" : "";
		if (normalized.corpus) params.push(normalized.corpus);
		params.push(normalized.limit);
		const rows = this.db
			.prepare(
				`SELECT c.*, f.rank AS score
				 FROM memory_fts f
				 JOIN memory_chunks c ON c.id = f.rowid
				 WHERE memory_fts MATCH ?
				 ${corpusFilter}
				 ORDER BY f.rank
				 LIMIT ?`,
			)
			.all(...params) as Array<MemoryChunkRow & { score: number }>;
		return rows.map((row) => ({ id: row.id, score: row.score, chunk: rowToChunk(row) }));
	}

	searchSemantic(query: Float32Array, options: number | MemorySearchOptions = {}): MemorySearchHit[] {
		const normalized = normalizeSearchOptions(options);
		if (query.length !== this.embeddingDimensions) {
			throw new Error(`Query vector dimension mismatch: expected ${this.embeddingDimensions}, got ${query.length}`);
		}
		const rows = this.db
			.prepare(normalized.corpus ? "SELECT * FROM memory_chunks WHERE corpus = ?" : "SELECT * FROM memory_chunks")
			.all(...(normalized.corpus ? [normalized.corpus] : [])) as MemoryChunkRow[];
		return rows
			.map((row) => ({
				id: row.id,
				score: cosineDistance(query, decodeVector(row.embedding, row.embedding_dimensions)),
				chunk: rowToChunk(row),
			}))
			.sort((a, b) => a.score - b.score)
			.slice(0, normalized.limit);
	}

	deleteChunk(id: number): void {
		const remove = this.db.transaction(() => {
			this.db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(id);
			this.db.prepare("DELETE FROM memory_chunks WHERE id = ?").run(id);
		});
		remove.immediate();
	}

	deleteBySource(corpus: string, sourceId: string): void {
		this.db.transaction(() => this.deleteBySourceInternal(corpus, sourceId)).immediate();
	}

	deleteBySourceExceptHashes(corpus: string, sourceId: string, contentHashes: readonly string[]): void {
		const uniqueHashes = [...new Set(contentHashes)];
		if (uniqueHashes.length === 0) {
			this.deleteBySource(corpus, sourceId);
			return;
		}

		const placeholders = uniqueHashes.map(() => "?").join(",");
		this.db
			.transaction(() => {
				const rows = this.db
					.prepare(
						`SELECT id FROM memory_chunks
						 WHERE corpus = ? AND source_id = ? AND content_hash NOT IN (${placeholders})`,
					)
					.all(corpus, sourceId, ...uniqueHashes) as { id: number }[];
				for (const row of rows) this.db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(row.id);
				this.db
					.prepare(
						`DELETE FROM memory_chunks
						 WHERE corpus = ? AND source_id = ? AND content_hash NOT IN (${placeholders})`,
					)
					.run(corpus, sourceId, ...uniqueHashes);
			})
			.immediate();
	}

	clearAll(): void {
		this.db
			.transaction(() => {
				this.db.prepare("DELETE FROM memory_fts").run();
				this.db.prepare("DELETE FROM memory_chunks").run();
			})
			.immediate();
	}

	stats(): MemoryIndexStats {
		const indexed = (this.db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get() as { n: number }).n;
		const ftsRows = (this.db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as { n: number }).n;
		const size = this.db
			.prepare("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()")
			.get() as { bytes: number };
		const dimensionsRaw = readMeta(this.db, "embedding_dimensions");
		return {
			indexed,
			ftsRows,
			vectorRows: indexed,
			vectorAvailable: true,
			embeddingProvider: readMeta(this.db, "embedding_provider"),
			embeddingModel: readMeta(this.db, "embedding_model"),
			embeddingDimensions: dimensionsRaw ? Number(dimensionsRaw) : null,
			dbSizeBytes: size.bytes,
		};
	}

	private normalizeInput(input: MemoryChunkInput): NormalizedChunkInput {
		if (input.embedding.length !== this.embeddingDimensions) {
			throw new Error(
				`Embedding dimension mismatch: expected ${this.embeddingDimensions}, got ${input.embedding.length}`,
			);
		}
		const text = input.text.trim();
		if (!text) throw new Error("Memory chunk text must not be empty");
		const chunkIndex = input.chunkIndex ?? 0;
		const snippet = input.snippet?.trim() || text.slice(0, 280);
		return {
			corpus: input.corpus,
			sourceId: input.sourceId ?? null,
			sourceRef: input.sourceRef ?? null,
			chunkIndex,
			text,
			snippet,
			tokenCount: input.tokenCount ?? null,
			metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
			embedding: input.embedding,
			contentHash: createMemoryContentHash({
				corpus: input.corpus,
				sourceId: input.sourceId ?? null,
				chunkIndex,
				text,
				embeddingModel: this.embeddingModel,
				embeddingDimensions: this.embeddingDimensions,
			}),
		};
	}

	private insertNormalized(item: NormalizedChunkInput): number {
		const existing = this.db.prepare("SELECT id FROM memory_chunks WHERE content_hash = ?").get(item.contentHash) as
			| { id: number }
			| undefined;
		if (existing) return existing.id;

		const result = this.db
			.prepare(
				`INSERT INTO memory_chunks (
					content_hash, corpus, source_id, source_ref, chunk_index, text_full,
					snippet, token_count, metadata_json, embedding_model,
					embedding_dimensions, embedding
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				item.contentHash,
				item.corpus,
				item.sourceId,
				item.sourceRef,
				item.chunkIndex,
				item.text,
				item.snippet,
				item.tokenCount,
				item.metadataJson,
				this.embeddingModel,
				this.embeddingDimensions,
				encodeVector(item.embedding),
			);
		const id = Number(result.lastInsertRowid);
		this.db
			.prepare("INSERT INTO memory_fts(rowid, text_full, snippet) VALUES (?, ?, ?)")
			.run(id, item.text, item.snippet);
		return id;
	}

	private deleteBySourceInternal(corpus: string, sourceId: string): void {
		const rows = this.db
			.prepare("SELECT id FROM memory_chunks WHERE corpus = ? AND source_id = ?")
			.all(corpus, sourceId) as {
			id: number;
		}[];
		for (const row of rows) this.db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(row.id);
		this.db.prepare("DELETE FROM memory_chunks WHERE corpus = ? AND source_id = ?").run(corpus, sourceId);
	}
}

interface NormalizedChunkInput {
	contentHash: string;
	corpus: string;
	sourceId: string | null;
	sourceRef: string | null;
	chunkIndex: number;
	text: string;
	snippet: string;
	tokenCount: number | null;
	metadataJson: string | null;
	embedding: Float32Array;
}

export function createMemoryContentHash(input: {
	corpus: string;
	sourceId: string | null;
	chunkIndex: number;
	text: string;
	embeddingModel: string;
	embeddingDimensions: number;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				corpus: input.corpus,
				sourceId: input.sourceId,
				chunkIndex: input.chunkIndex,
				text: input.text,
				embeddingModel: input.embeddingModel,
				embeddingDimensions: input.embeddingDimensions,
			}),
		)
		.digest("hex");
}

function normalizeSearchOptions(options: number | MemorySearchOptions): { limit: number; corpus?: string } {
	if (typeof options === "number") return { limit: options };
	return {
		limit: options.limit ?? 10,
		corpus: options.corpus,
	};
}

function normalizeFtsMatchQuery(query: string): string | null {
	const tokens = query
		.normalize("NFKC")
		.match(/[\p{L}\p{N}_]+/gu)
		?.map((token) => `"${token.replaceAll('"', '""')}"`);
	return tokens && tokens.length > 0 ? tokens.join(" ") : null;
}

function rowToChunk(row: MemoryChunkRow): StoredMemoryChunk {
	return {
		id: row.id,
		contentHash: row.content_hash,
		corpus: row.corpus,
		sourceId: row.source_id,
		sourceRef: row.source_ref,
		chunkIndex: row.chunk_index,
		text: row.text_full,
		snippet: row.snippet,
		tokenCount: row.token_count,
		metadata: parseMetadata(row.metadata_json),
		embeddingModel: row.embedding_model,
		embeddingDimensions: row.embedding_dimensions,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
