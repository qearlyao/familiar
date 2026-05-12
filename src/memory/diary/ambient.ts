import type { EmbeddingProvider } from "../index/embedding-provider.js";
import {
	type MemoryRetrievalHit,
	type MemoryRetrievalStore,
	type RetrieveMemoryOptions,
	retrieveMemory,
} from "../index/retrieval.js";
import type { StoredMemoryChunk } from "../index/store.js";
import { DIARY_CHUNK_CORPUS } from "./chunks.js";

export interface AmbientDiaryRecallOptions {
	query: string;
	store: MemoryRetrievalStore;
	embeddingProvider?: Pick<EmbeddingProvider, "embedOne"> | null;
	limit?: number;
	candidateLimit?: number;
	now?: Date;
	recencyHalfLifeDays?: number;
	metadataBoosts?: AmbientDiaryMetadataBoosts;
	weights?: AmbientDiaryWeights;
	useLexical?: boolean;
	useSemantic?: boolean;
	signal?: AbortSignal;
}

export interface AmbientDiaryWeights extends AmbientDiaryMetadataBoosts {
	similarity?: number;
}

export interface AmbientDiaryMetadataBoosts {
	valence?: number;
	intensity?: number;
	recency?: number;
}

export interface AmbientDiaryHit extends MemoryRetrievalHit {
	ambientScore: number;
	boosts: {
		similarity: number;
		valence: number;
		intensity: number;
		recency: number;
	};
}

const DEFAULT_LIMIT = 4;
const DEFAULT_CANDIDATE_MULTIPLIER = 5;
const DEFAULT_HALF_LIFE_DAYS = 45;
const MAX_AMBIENT_SEMANTIC_DISTANCE = 0.38;
const DEFAULT_WEIGHTS: Required<AmbientDiaryWeights> = {
	similarity: 1.0,
	valence: 0.08,
	intensity: 0.1,
	recency: 0.08,
};

export async function retrieveAmbientDiary(options: AmbientDiaryRecallOptions): Promise<AmbientDiaryHit[]> {
	const limit = positiveIntegerOrDefault(options.limit, DEFAULT_LIMIT);
	const candidateLimit = positiveIntegerOrDefault(
		options.candidateLimit,
		Math.max(limit * DEFAULT_CANDIDATE_MULTIPLIER, limit),
	);
	const hits = await retrieveMemory({
		query: options.query,
		store: options.store,
		embeddingProvider: options.embeddingProvider,
		scope: { corpora: [DIARY_CHUNK_CORPUS] },
		limit: candidateLimit,
		candidateLimit,
		useLexical: options.useLexical,
		useSemantic: options.useSemantic,
		signal: options.signal,
	} satisfies RetrieveMemoryOptions);

	const weights = { ...DEFAULT_WEIGHTS, ...options.metadataBoosts, ...options.weights };
	const now = options.now ?? new Date();
	const halfLifeDays = positiveIntegerOrDefault(options.recencyHalfLifeDays, DEFAULT_HALF_LIFE_DAYS);

	const scored = hits.map((hit) => scoreAmbientHit(hit, { now, halfLifeDays, weights }));
	const relevant = scored.filter(hasAmbientRelevance);
	debugAmbientHits(options.query, scored, relevant);
	return relevant.sort(compareAmbientHits).slice(0, limit);
}

function hasAmbientRelevance(hit: AmbientDiaryHit): boolean {
	if (hit.semanticScore === null) return hit.lexicalRank !== null;
	return hit.semanticScore <= MAX_AMBIENT_SEMANTIC_DISTANCE;
}

function debugAmbientHits(query: string, scored: AmbientDiaryHit[], relevant: AmbientDiaryHit[]): void {
	if (
		!process.env.DEBUG?.split(",")
			.map((part) => part.trim())
			.includes("memory-ambient")
	)
		return;
	const relevantIds = new Set(relevant.map((hit) => hit.id));
	console.error(
		JSON.stringify({
			event: "ambient_diary_hits",
			query,
			maxSemanticDistance: MAX_AMBIENT_SEMANTIC_DISTANCE,
			hits: scored.map((hit) => ({
				id: hit.id,
				passed: relevantIds.has(hit.id),
				ambientScore: hit.ambientScore,
				lexicalRank: hit.lexicalRank,
				semanticRank: hit.semanticRank,
				lexicalScore: hit.lexicalScore,
				semanticScore: hit.semanticScore,
				snippet: (hit.chunk.snippet || hit.chunk.text).slice(0, 120),
			})),
		}),
	);
}

function scoreAmbientHit(
	hit: MemoryRetrievalHit,
	options: { now: Date; halfLifeDays: number; weights: Required<AmbientDiaryWeights> },
): AmbientDiaryHit {
	const similarity = hit.score * options.weights.similarity;
	const valence = normalizeValence(metadataNumber(hit.chunk, "valence")) * options.weights.valence;
	const intensity = normalizeUnit(metadataNumber(hit.chunk, "intensity")) * options.weights.intensity;
	const recency = recencyScore(hit.chunk, options.now, options.halfLifeDays) * options.weights.recency;
	const ambientScore = similarity + valence + intensity + recency;
	return {
		...hit,
		ambientScore,
		boosts: { similarity, valence, intensity, recency },
	};
}

function compareAmbientHits(a: AmbientDiaryHit, b: AmbientDiaryHit): number {
	return (
		b.ambientScore - a.ambientScore ||
		b.score - a.score ||
		(a.semanticRank ?? Number.POSITIVE_INFINITY) - (b.semanticRank ?? Number.POSITIVE_INFINITY) ||
		(a.lexicalRank ?? Number.POSITIVE_INFINITY) - (b.lexicalRank ?? Number.POSITIVE_INFINITY) ||
		a.id - b.id
	);
}

function recencyScore(chunk: StoredMemoryChunk, now: Date, halfLifeDays: number): number {
	const date = metadataDate(chunk) ?? timestampDate(chunk.createdAt);
	if (!date) return 0;
	const ageMs = Math.max(0, now.getTime() - date.getTime());
	const ageDays = ageMs / 86_400_000;
	return 0.5 ** (ageDays / halfLifeDays);
}

function metadataDate(chunk: StoredMemoryChunk): Date | null {
	const value = chunk.metadata?.date;
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const date = new Date(`${value}T00:00:00.000Z`);
	return Number.isNaN(date.getTime()) ? null : date;
}

function timestampDate(value: number): Date | null {
	if (!Number.isFinite(value) || value <= 0) return null;
	const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
	const date = new Date(milliseconds);
	return Number.isNaN(date.getTime()) ? null : date;
}

function metadataNumber(chunk: StoredMemoryChunk, key: string): number | null {
	const value = chunk.metadata?.[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return null;
}

function normalizeValence(value: number | null): number {
	if (value === null) return 0;
	return Math.max(0, Math.min(1, value));
}

function normalizeUnit(value: number | null): number {
	if (value === null) return 0;
	const absolute = Math.abs(value);
	return Math.max(0, Math.min(1, absolute > 1 ? absolute / 10 : absolute));
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}
