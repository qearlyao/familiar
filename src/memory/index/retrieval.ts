import { positiveIntegerOrDefault } from "../util.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import type { MemorySearchHit, StoredMemoryChunk } from "./store.js";
export interface MemoryRetrievalStore {
	searchLexical(query: string, options?: number | MemoryRetrievalSearchOptions): MemorySearchHit[];
	searchSemantic(query: Float32Array, options?: number | MemoryRetrievalSearchOptions): MemorySearchHit[];
}

export interface MemoryRetrievalSearchOptions {
	limit?: number;
	corpus?: string | undefined;
}

export interface MemoryRetrievalScope {
	corpora?: readonly string[];
	sourceIds?: readonly string[];
	sourceRefs?: readonly string[];
	before?: string;
	after?: string;
}

export interface RetrieveMemoryOptions {
	query: string;
	store: MemoryRetrievalStore;
	embeddingProvider?: Pick<EmbeddingProvider, "embedOne"> | null;
	scope?: MemoryRetrievalScope;
	limit?: number;
	candidateLimit?: number;
	useLexical?: boolean;
	useSemantic?: boolean;
	signal?: AbortSignal;
}

export interface MemoryRetrievalHit {
	id: number;
	score: number;
	chunk: StoredMemoryChunk;
	lexicalRank: number | null;
	semanticRank: number | null;
	lexicalScore: number | null;
	semanticScore: number | null;
}

const DEFAULT_LIMIT = 8;
const DEFAULT_CANDIDATE_MULTIPLIER = 4;
const RRF_K = 60;
const TEXT_DEDUPE_MIN_CHARS = 24;

export async function retrieveMemory(options: RetrieveMemoryOptions): Promise<MemoryRetrievalHit[]> {
	const query = options.query.trim();
	if (!query) return [];

	const limit = positiveIntegerOrDefault(options.limit, DEFAULT_LIMIT);
	const candidateLimit = positiveIntegerOrDefault(
		options.candidateLimit,
		Math.max(limit * DEFAULT_CANDIDATE_MULTIPLIER, limit),
	);
	const useLexical = options.useLexical ?? true;
	const useSemantic = options.useSemantic ?? Boolean(options.embeddingProvider);

	const lexicalHits = useLexical ? searchLexicalByScope(options.store, query, candidateLimit, options.scope) : [];
	const semanticHits =
		useSemantic && options.embeddingProvider
			? await searchSemanticByScope(
					options.store,
					options.embeddingProvider,
					query,
					candidateLimit,
					options.scope,
					options.signal,
				)
			: [];

	return dedupeMemoryHits(mergeRankedHits(lexicalHits, semanticHits, options.scope)).slice(0, limit);
}

function searchLexicalByScope(
	store: MemoryRetrievalStore,
	query: string,
	limit: number,
	scope: MemoryRetrievalScope | undefined,
): MemorySearchHit[] {
	const corpora = uniqueStrings(scope?.corpora);
	if (corpora.length === 0) return store.searchLexical(query, { limit });
	return corpora.flatMap((corpus) => store.searchLexical(query, { limit, corpus }));
}

async function searchSemanticByScope(
	store: MemoryRetrievalStore,
	provider: Pick<EmbeddingProvider, "embedOne">,
	query: string,
	limit: number,
	scope: MemoryRetrievalScope | undefined,
	signal: AbortSignal | undefined,
): Promise<MemorySearchHit[]> {
	let vector: Float32Array;
	try {
		vector = await provider.embedOne(query, signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		return [];
	}
	const corpora = uniqueStrings(scope?.corpora);
	if (corpora.length === 0) return store.searchSemantic(vector, { limit });
	return corpora.flatMap((corpus) => store.searchSemantic(vector, { limit, corpus }));
}

function mergeRankedHits(
	lexicalHits: readonly MemorySearchHit[],
	semanticHits: readonly MemorySearchHit[],
	scope: MemoryRetrievalScope | undefined,
): MemoryRetrievalHit[] {
	const merged = new Map<number, MemoryRetrievalHit>();
	addHits(merged, lexicalHits, "lexical", scope);
	addHits(merged, semanticHits, "semantic", scope);
	return Array.from(merged.values()).sort(compareRetrievalHits);
}

function addHits(
	merged: Map<number, MemoryRetrievalHit>,
	hits: readonly MemorySearchHit[],
	channel: "lexical" | "semantic",
	scope: MemoryRetrievalScope | undefined,
): void {
	const ranksByCorpus = new Map<string, number>();
	const rankByCorpus = uniqueStrings(scope?.corpora).length > 0;
	for (const hit of hits) {
		if (!matchesScope(hit.chunk, scope)) continue;
		const corpus = rankByCorpus ? hit.chunk.corpus : "";
		// Corpus-scoped searches are independent retriever lists; each corpus starts
		// RRF rank at 1 so fan-out order does not penalize later corpora.
		const rank = (ranksByCorpus.get(corpus) ?? 0) + 1;
		ranksByCorpus.set(corpus, rank);
		const existing = merged.get(hit.id);
		if (!existing) {
			merged.set(hit.id, {
				id: hit.id,
				score: reciprocalRank(rank),
				chunk: hit.chunk,
				lexicalRank: channel === "lexical" ? rank : null,
				semanticRank: channel === "semantic" ? rank : null,
				lexicalScore: channel === "lexical" ? hit.score : null,
				semanticScore: channel === "semantic" ? hit.score : null,
			});
			continue;
		}
		existing.score += reciprocalRank(rank);
		if (channel === "lexical") {
			existing.lexicalRank = rank;
			existing.lexicalScore = hit.score;
		} else {
			existing.semanticRank = rank;
			existing.semanticScore = hit.score;
		}
	}
}

function compareRetrievalHits(a: MemoryRetrievalHit, b: MemoryRetrievalHit): number {
	return (
		b.score - a.score ||
		bestRank(a) - bestRank(b) ||
		(a.semanticScore ?? Number.POSITIVE_INFINITY) - (b.semanticScore ?? Number.POSITIVE_INFINITY) ||
		(a.lexicalScore ?? Number.POSITIVE_INFINITY) - (b.lexicalScore ?? Number.POSITIVE_INFINITY) ||
		a.id - b.id
	);
}

function bestRank(hit: MemoryRetrievalHit): number {
	return Math.min(hit.lexicalRank ?? Number.POSITIVE_INFINITY, hit.semanticRank ?? Number.POSITIVE_INFINITY);
}

function dedupeMemoryHits(hits: readonly MemoryRetrievalHit[]): MemoryRetrievalHit[] {
	const groups: MemoryRetrievalHit[][] = [];
	const groupByKey = new Map<string, number>();
	for (const hit of hits) {
		const keys = memoryDedupeKeys(hit.chunk);
		const groupIndexes = new Set<number>();
		for (const key of keys) {
			const groupIndex = groupByKey.get(key);
			if (groupIndex !== undefined) groupIndexes.add(groupIndex);
		}
		const targetIndex = groupIndexes.size > 0 ? Math.min(...groupIndexes) : groups.length;
		const target = groups[targetIndex] ?? [];
		target.push(hit);
		groups[targetIndex] = target;
		for (const groupIndex of groupIndexes) {
			if (groupIndex === targetIndex) continue;
			for (const grouped of groups[groupIndex] ?? []) {
				target.push(grouped);
				for (const key of memoryDedupeKeys(grouped.chunk)) groupByKey.set(key, targetIndex);
			}
			groups[groupIndex] = [];
		}
		for (const key of keys) groupByKey.set(key, targetIndex);
	}
	return groups
		.filter((group) => group.length > 0)
		.map((group) => group.sort(compareRetrievalHits)[0])
		.filter((hit): hit is MemoryRetrievalHit => hit !== undefined)
		.sort(compareRetrievalHits);
}

function memoryDedupeKeys(chunk: StoredMemoryChunk): string[] {
	const keys = new Set<string>();
	const text = normalizeMemoryText(chunk.text);
	if (text) {
		if (text.length >= TEXT_DEDUPE_MIN_CHARS) keys.add(`text:${chunk.corpus}:${text}`);
		const kind = metadataString(chunk.metadata, "kind") ?? "";
		const rounded = roundedChunkTimestamp(chunk);
		if (kind && rounded !== null) keys.add(`turn:${chunk.corpus}:${kind}:${rounded}:${text}`);
	}
	const sourceMessageId =
		metadataString(chunk.metadata, "sourceMessageId") ?? metadataSourceString(chunk, "sourceMessageId");
	if (sourceMessageId) keys.add(`message:${chunk.corpus}:${sourceMessageId}`);
	return [...keys];
}

function normalizeMemoryText(text: string): string {
	return text
		.replace(/^\s*\[[^\]]+\]\s*/, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function roundedChunkTimestamp(chunk: StoredMemoryChunk): number | null {
	const timestamp = chunkTimestamp(chunk);
	return timestamp === null ? null : Math.round(timestamp / 60_000);
}

function metadataString(metadata: StoredMemoryChunk["metadata"], key: string): string | null {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataSourceString(chunk: StoredMemoryChunk, key: string): string | null {
	const source = chunk.metadata?.source;
	if (!source || typeof source !== "object") return null;
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function reciprocalRank(rank: number): number {
	return 1 / (RRF_K + rank);
}

function matchesScope(chunk: StoredMemoryChunk, scope: MemoryRetrievalScope | undefined): boolean {
	const corpora = uniqueStrings(scope?.corpora);
	if (corpora.length > 0 && !corpora.includes(chunk.corpus)) return false;
	if (!matchesTimeScope(chunk, scope)) return false;

	const sourceIds = uniqueStrings(scope?.sourceIds);
	if (
		sourceIds.length > 0 &&
		!chunk.sources.some((source) => source.sourceId && sourceIds.includes(source.sourceId))
	) {
		return false;
	}

	const sourceRefs = uniqueStrings(scope?.sourceRefs);
	if (
		sourceRefs.length > 0 &&
		!chunk.sources.some((source) => source.sourceRef && sourceRefs.includes(source.sourceRef))
	) {
		return false;
	}

	return true;
}

function matchesTimeScope(chunk: StoredMemoryChunk, scope: MemoryRetrievalScope | undefined): boolean {
	const after = parseIsoTime(scope?.after);
	const before = parseIsoTime(scope?.before);
	if (after === null && before === null) return true;
	const timestamp = chunkTimestamp(chunk);
	if (timestamp === null) return false;
	if (after !== null && timestamp < after) return false;
	if (before !== null && timestamp > before) return false;
	return true;
}

function chunkTimestamp(chunk: StoredMemoryChunk): number | null {
	const raw = firstMetadataValue(chunk.metadata, [
		"timestamp",
		"happenedAt",
		"coverageToHappenedAt",
		"coverageFromHappenedAt",
	]);
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (typeof raw === "number" && Number.isFinite(raw)) return raw < 10_000_000_000 ? raw * 1000 : raw;
	return chunk.createdAt < 10_000_000_000 ? chunk.createdAt * 1000 : chunk.createdAt;
}

function firstMetadataValue(
	metadata: StoredMemoryChunk["metadata"],
	keys: readonly string[],
): string | number | null | undefined {
	if (!metadata) return null;
	for (const key of keys) {
		const value = metadata[key];
		if (typeof value === "string" || typeof value === "number") return value;
	}
	return null;
}

function parseIsoTime(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
	return Array.from(new Set(values?.filter((value) => value.trim()) ?? []));
}
