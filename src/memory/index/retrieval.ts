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

	return mergeRankedHits(lexicalHits, semanticHits, options.scope).slice(0, limit);
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
	let rank = 0;
	for (const hit of hits) {
		if (!matchesScope(hit.chunk, scope)) continue;
		rank += 1;
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

function reciprocalRank(rank: number): number {
	return 1 / (RRF_K + rank);
}

function matchesScope(chunk: StoredMemoryChunk, scope: MemoryRetrievalScope | undefined): boolean {
	const corpora = uniqueStrings(scope?.corpora);
	if (corpora.length > 0 && !corpora.includes(chunk.corpus)) return false;

	const sourceIds = uniqueStrings(scope?.sourceIds);
	if (sourceIds.length > 0 && (!chunk.sourceId || !sourceIds.includes(chunk.sourceId))) return false;

	const sourceRefs = uniqueStrings(scope?.sourceRefs);
	if (sourceRefs.length > 0 && (!chunk.sourceRef || !sourceRefs.includes(chunk.sourceRef))) return false;

	return true;
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
	return Array.from(new Set(values?.filter((value) => value.trim()) ?? []));
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}
