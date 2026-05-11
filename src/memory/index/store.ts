import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import type { Config } from "../../config.js";
import { normalizeFtsMatchQuery } from "./fts-query.js";
import { readMeta, runMemoryIndexMigrations } from "./schema.js";
import type { VectorCapability } from "./vec.js";
import { cosineDistance, decodeVector, encodeVector } from "./vector-codec.js";

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
	sources: MemoryChunkSourceRef[];
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

export interface MemoryChunkSourceRef {
	corpus: string;
	sourceId: string;
	sourceRef: string | null;
	chunkIndex: number;
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
	vectorCapability: VectorCapability;
	requiresReindex: boolean;
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
	source_id?: string | null;
	source_ref?: string | null;
	chunk_index?: number;
	text_full: string;
	snippet: string;
	token_count: number | null;
	metadata_json: string | null;
	embedding_model: string;
	embedding_dimensions: number;
	embedding: Buffer;
	created_at: number;
	updated_at: number;
	sources_json?: string | null;
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

	recordSourceMappings(inputs: MemoryChunkInput[]): void {
		if (inputs.length === 0) return;
		const rows = inputs.map((input) => this.normalizeInput(input));
		this.db
			.transaction((items: NormalizedChunkInput[]) => {
				for (const item of items) {
					const existing = this.db
						.prepare("SELECT id FROM memory_chunks WHERE content_hash = ?")
						.get(item.contentHash) as { id: number } | undefined;
					if (existing) this.insertSourceMapping(existing.id, item);
				}
			})
			.immediate(rows);
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
		const row = this.db
			.prepare(`SELECT c.*, ${sourcesJsonSelect("c.id")} FROM memory_chunks c WHERE c.id = ?`)
			.get(id) as MemoryChunkRow | undefined;
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
				`SELECT c.*, f.rank AS score, ${sourcesJsonSelect("c.id")}
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
		// memory_vec does not carry corpus metadata, so sqlite-vec cannot prefilter
		// corpus-scoped KNN. Use the linear path to keep scoped nearest neighbors exact.
		if (this.vectorCapability() === "sqlite-vec" && !normalized.corpus)
			return this.searchSemanticVec(query, normalized);
		return this.searchSemanticLinear(query, normalized);
	}

	private searchSemanticVec(query: Float32Array, normalized: { limit: number; corpus?: string }): MemorySearchHit[] {
		const params: unknown[] = [encodeVector(query), normalized.limit];
		if (normalized.corpus) params.push(normalized.corpus);
		const corpusFilter = normalized.corpus ? "WHERE c.corpus = ?" : "";
		const rows = this.db
			.prepare(
				`SELECT c.*, v.distance AS score, ${sourcesJsonSelect("c.id")}
				 FROM (
					SELECT rowid AS chunk_id, distance
					FROM memory_vec
					WHERE embedding MATCH ? AND k = ?
				 ) v
				 JOIN memory_chunks c ON c.id = v.chunk_id
				 ${corpusFilter}
				 ORDER BY v.distance
				 LIMIT ?`,
			)
			.all(...params, normalized.limit) as Array<MemoryChunkRow & { score: number }>;
		return rows.map((row) => ({ id: row.id, score: row.score, chunk: rowToChunk(row) }));
	}

	private searchSemanticLinear(
		query: Float32Array,
		normalized: { limit: number; corpus?: string },
	): MemorySearchHit[] {
		const rows = this.db
			.prepare(
				normalized.corpus
					? `SELECT c.*, ${sourcesJsonSelect("c.id")} FROM memory_chunks c WHERE c.corpus = ?`
					: `SELECT c.*, ${sourcesJsonSelect("c.id")} FROM memory_chunks c`,
			)
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
			this.deleteFtsRow(id);
			this.db.prepare("DELETE FROM memory_chunks WHERE id = ?").run(id);
		});
		remove.immediate();
	}

	deleteBySource(corpus: string, sourceId: string): void {
		this.db.transaction(() => this.deleteBySourceInternal(corpus, sourceId)).immediate();
	}

	/** Caller already owns the index DB write transaction. */
	deleteBySourceUnsafe(corpus: string, sourceId: string): void {
		this.deleteBySourceInternal(corpus, sourceId);
	}

	deleteBySourceExceptHashes(corpus: string, sourceId: string, contentHashes: readonly string[]): void {
		this.deleteBySourceExceptMappings(
			corpus,
			sourceId,
			[...new Set(contentHashes)].map((contentHash) => ({ contentHash, chunkIndex: null })),
		);
	}

	deleteBySourceExceptMappings(
		corpus: string,
		sourceId: string,
		kept: readonly { contentHash: string; chunkIndex: number | null }[],
	): void {
		if (kept.length === 0) {
			this.deleteBySource(corpus, sourceId);
			return;
		}

		this.db
			.transaction(() => {
				const rows = this.db
					.prepare(
						`SELECT s.chunk_id AS id, c.content_hash, s.chunk_index
						 FROM memory_index_sources s
						 JOIN memory_chunks c ON c.id = s.chunk_id
						 WHERE s.corpus = ? AND s.source_id = ?`,
					)
					.all(corpus, sourceId) as { id: number; content_hash: string; chunk_index: number }[];
				for (const row of rows) {
					if (
						kept.some(
							(item) =>
								item.contentHash === row.content_hash &&
								(item.chunkIndex === null || item.chunkIndex === row.chunk_index),
						)
					) {
						continue;
					}
					this.db
						.prepare("DELETE FROM memory_index_sources WHERE corpus = ? AND source_id = ? AND chunk_index = ?")
						.run(corpus, sourceId, row.chunk_index);
					this.deleteOrphanChunk(row.id);
				}
			})
			.immediate();
	}

	clearAll(): void {
		this.db
			.transaction(() => {
				this.db.prepare("INSERT INTO memory_fts(memory_fts) VALUES ('delete-all')").run();
				if (this.vectorCapability() === "sqlite-vec") this.db.prepare("DELETE FROM memory_vec").run();
				this.db.prepare("DELETE FROM memory_index_sources").run();
				this.db.prepare("DELETE FROM memory_chunks").run();
			})
			.immediate();
	}

	reconcileSources(exists: (source: MemoryChunkSourceRef) => boolean): void {
		const sources = this.db
			.prepare("SELECT chunk_id, corpus, source_id, source_ref, chunk_index FROM memory_index_sources")
			.all() as Array<{
			chunk_id: number;
			corpus: string;
			source_id: string;
			source_ref: string | null;
			chunk_index: number;
		}>;
		if (sources.length === 0) return;
		this.db
			.transaction(() => {
				for (const row of sources) {
					const source = {
						corpus: row.corpus,
						sourceId: row.source_id,
						sourceRef: row.source_ref,
						chunkIndex: row.chunk_index,
					};
					if (exists(source)) continue;
					this.db
						.prepare("DELETE FROM memory_index_sources WHERE corpus = ? AND source_id = ? AND chunk_index = ?")
						.run(source.corpus, source.sourceId, source.chunkIndex);
					this.deleteOrphanChunk(row.chunk_id);
				}
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
		const vectorCapability = this.vectorCapability();
		const vectorRows = vectorCapability === "sqlite-vec" ? this.vectorRowCount() : indexed;
		return {
			indexed,
			ftsRows,
			vectorRows,
			vectorAvailable: vectorCapability === "sqlite-vec",
			vectorCapability,
			requiresReindex: readMeta(this.db, "requires_reindex") === "1",
			embeddingProvider: readMeta(this.db, "embedding_provider"),
			embeddingModel: readMeta(this.db, "embedding_model"),
			embeddingDimensions: dimensionsRaw ? Number(dimensionsRaw) : null,
			dbSizeBytes: size.bytes,
		};
	}

	private vectorCapability(): VectorCapability {
		return readMeta(this.db, "vector_capability") === "sqlite-vec" ? "sqlite-vec" : "blob-js";
	}

	private vectorRowCount(): number {
		try {
			const row = this.db.prepare("SELECT COUNT(*) AS n FROM memory_vec").get() as { n: number };
			return row.n;
		} catch {
			return 0;
		}
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
		if (existing) {
			this.insertSourceMapping(existing.id, item);
			return existing.id;
		}

		const result = this.db
			.prepare(
				`INSERT INTO memory_chunks (
					content_hash, corpus, text_full, snippet, token_count, metadata_json, embedding_model,
					embedding_dimensions, embedding
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				item.contentHash,
				item.corpus,
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
		if (this.vectorCapability() === "sqlite-vec") {
			this.db
				.prepare("INSERT INTO memory_vec(rowid, embedding) VALUES (?, ?)")
				.run(id, encodeVector(item.embedding));
		}
		this.insertSourceMapping(id, item);
		return id;
	}

	private deleteBySourceInternal(corpus: string, sourceId: string): void {
		const rows = this.db
			.prepare("SELECT chunk_id AS id FROM memory_index_sources WHERE corpus = ? AND source_id = ?")
			.all(corpus, sourceId) as {
			id: number;
		}[];
		this.db.prepare("DELETE FROM memory_index_sources WHERE corpus = ? AND source_id = ?").run(corpus, sourceId);
		for (const row of rows) this.deleteOrphanChunk(row.id);
	}

	private insertSourceMapping(chunkId: number, item: NormalizedChunkInput): void {
		if (!item.sourceId) return;
		this.db
			.prepare(
				`INSERT OR REPLACE INTO memory_index_sources(chunk_id, corpus, source_id, source_ref, chunk_index)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(chunkId, item.corpus, item.sourceId, item.sourceRef, item.chunkIndex);
	}

	private deleteOrphanChunk(id: number): void {
		const remaining = this.db
			.prepare("SELECT 1 AS ok FROM memory_index_sources WHERE chunk_id = ? LIMIT 1")
			.get(id) as { ok: number } | undefined;
		if (remaining) return;
		this.deleteFtsRow(id);
		this.db.prepare("DELETE FROM memory_chunks WHERE id = ?").run(id);
	}

	private deleteFtsRow(id: number): void {
		this.db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(id);
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
	sourceId?: string | null;
	chunkIndex?: number;
	text: string;
	embeddingModel: string;
	embeddingDimensions: number;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				corpus: input.corpus,
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

function sourcesJsonSelect(chunkIdExpr: string): string {
	return `(SELECT json_group_array(json_object(
		'corpus', s.corpus,
		'sourceId', s.source_id,
		'sourceRef', s.source_ref,
		'chunkIndex', s.chunk_index
	)) FROM memory_index_sources s WHERE s.chunk_id = ${chunkIdExpr}) AS sources_json`;
}

function rowToChunk(row: MemoryChunkRow): StoredMemoryChunk {
	const sources = sourceRefsFromRow(row);
	const primary = sources[0] ?? {
		corpus: row.corpus,
		sourceId: row.source_id ?? null,
		sourceRef: row.source_ref ?? null,
		chunkIndex: row.chunk_index ?? 0,
	};
	return {
		id: row.id,
		contentHash: row.content_hash,
		corpus: row.corpus,
		sourceId: primary.sourceId,
		sourceRef: primary.sourceRef,
		chunkIndex: primary.chunkIndex,
		sources,
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

function sourceRefsFromRow(row: MemoryChunkRow): MemoryChunkSourceRef[] {
	if ("sources_json" in row && typeof row.sources_json === "string" && row.sources_json) {
		try {
			const parsed = JSON.parse(row.sources_json) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.filter(isSourceRef);
			}
		} catch {
			return [];
		}
	}
	const sourceId = row.source_id ?? null;
	return sourceId
		? [
				{
					corpus: row.corpus,
					sourceId,
					sourceRef: row.source_ref ?? null,
					chunkIndex: row.chunk_index ?? 0,
				},
			]
		: [];
}

function isSourceRef(value: unknown): value is MemoryChunkSourceRef {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return typeof item.corpus === "string" && typeof item.sourceId === "string";
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
