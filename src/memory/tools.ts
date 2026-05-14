import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";

import type { EmbeddingProvider } from "./index/embedding-provider.js";
import { type MemoryRetrievalHit, retrieveMemory } from "./index/retrieval.js";
import type { MemoryIndexStore, StoredMemoryChunk } from "./index/store.js";

const DEFAULT_RECALL_LIMIT = 8;
const MAX_TEXT_PREVIEW_CHARS = 700;
const MAX_CONTEXT_LABEL_CHARS = 120;
const MAX_SOURCE_LABEL_CHARS = 160;
const MEMORY_SCOPE_CORPORA = {
	diary: ["diary_chunk"],
	factual: ["atomic_fact", "lcm_record", "lcm_summary"],
	all: undefined,
} as const;

const memoryRecallSchema = Type.Object(
	{
		query: Type.String({ description: "Natural-language memory search query." }),
		scope: Type.Optional(
			Type.Union([Type.Literal("diary"), Type.Literal("factual"), Type.Literal("all")], {
				default: "all",
				description:
					"all searches every memory corpus; diary searches long-term diary memory; factual searches facts and conversation memory.",
			}),
		),
		mode: Type.Optional(
			Type.Union([Type.Literal("lexical"), Type.Literal("semantic"), Type.Literal("hybrid")], {
				default: "hybrid",
				description: "hybrid uses lexical and semantic recall; lexical and semantic restrict to one mode.",
			}),
		),
		before: Type.Optional(
			Type.String({
				description: "Only recall chunks whose metadata.timestamp or createdAt is at or before this ISO 8601 time.",
			}),
		),
		after: Type.Optional(
			Type.String({
				description: "Only recall chunks whose metadata.timestamp or createdAt is at or after this ISO 8601 time.",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				default: DEFAULT_RECALL_LIMIT,
				minimum: 1,
				maximum: 20,
			}),
		),
	},
	{ additionalProperties: false },
);

const memoryOpenSchema = Type.Object(
	{
		id: Type.Number({
			description: "Memory chunk id returned by memory_recall.",
			minimum: 1,
		}),
	},
	{ additionalProperties: false },
);

type MemoryRecallInput = Static<typeof memoryRecallSchema>;
type MemoryOpenInput = Static<typeof memoryOpenSchema>;
type MemoryRecallScope = keyof typeof MEMORY_SCOPE_CORPORA;
type MemoryRecallMode = "lexical" | "semantic" | "hybrid";

export interface MemoryToolDeps {
	store: MemoryIndexStore;
	embeddingProvider: EmbeddingProvider;
}

interface MemoryRecallDetails {
	query: string;
	scope: MemoryRecallScope;
	mode: MemoryRecallMode;
	limit: number;
	resultCount: number;
	ids: number[];
}

interface MemoryOpenDetails {
	id: number;
	found: boolean;
	corpus?: string;
	sourceId?: string | null;
	sourceRef?: string | null;
	chunkIndex?: number;
	sources?: StoredMemoryChunk["sources"];
}

export function createMemoryTools(deps: MemoryToolDeps): AgentTool<any>[] {
	return [makeMemoryRecallTool(deps), makeMemoryOpenTool(deps)];
}

function makeMemoryRecallTool(deps: MemoryToolDeps): AgentTool<typeof memoryRecallSchema, MemoryRecallDetails> {
	return {
		name: "memory_recall",
		label: "Memory Recall",
		description:
			"search memory for diary, fact, or conversation chunks. returns previews and ids; use memory_open for full text and source details.",
		parameters: memoryRecallSchema,
		async execute(_toolCallId, input: MemoryRecallInput, signal?: AbortSignal) {
			const query = input.query.trim();
			if (!query) throw new Error("memory_recall query is required.");
			const scope = input.scope ?? "all";
			const mode = input.mode ?? "hybrid";
			const limit = clampLimit(input.limit);
			assertIsoTime(input.before, "before");
			assertIsoTime(input.after, "after");
			const hits = await retrieveMemory({
				query,
				store: deps.store,
				embeddingProvider: deps.embeddingProvider,
				scope: { corpora: MEMORY_SCOPE_CORPORA[scope], before: input.before, after: input.after },
				limit,
				useLexical: mode !== "semantic",
				useSemantic: mode !== "lexical",
				signal,
			});
			return {
				content: [{ type: "text", text: formatRecallResults(hits) }],
				details: {
					query,
					scope,
					mode,
					limit,
					resultCount: hits.length,
					ids: hits.map((hit) => hit.id),
				},
			};
		},
	};
}

function makeMemoryOpenTool(deps: MemoryToolDeps): AgentTool<typeof memoryOpenSchema, MemoryOpenDetails> {
	return {
		name: "memory_open",
		label: "Memory Open",
		description: "open one stored memory chunk by id. returns the full text plus source details.",
		parameters: memoryOpenSchema,
		async execute(_toolCallId, input: MemoryOpenInput) {
			const id = Math.trunc(input.id);
			if (!Number.isInteger(input.id) || id < 1) throw new Error("memory_open id must be a positive integer.");
			const chunk = deps.store.getChunk(id);
			if (!chunk) {
				return {
					content: [{ type: "text", text: `No memory chunk found for id ${id}.` }],
					details: { id, found: false },
				};
			}
			return {
				content: [{ type: "text", text: formatOpenChunk(chunk) }],
				details: {
					id,
					found: true,
					corpus: chunk.corpus,
					sourceId: chunk.sourceId,
					sourceRef: chunk.sourceRef,
					chunkIndex: chunk.chunkIndex,
					sources: chunk.sources,
				},
			};
		},
	};
}

function clampLimit(value: number | undefined): number {
	if (value === undefined) return DEFAULT_RECALL_LIMIT;
	if (!Number.isInteger(value) || value < 1) throw new Error("memory_recall limit must be a positive integer.");
	return Math.min(value, 20);
}

function assertIsoTime(value: string | undefined, name: "before" | "after"): void {
	if (value === undefined) return;
	if (!Number.isFinite(Date.parse(value))) throw new Error(`memory_recall ${name} must be an ISO 8601 timestamp.`);
}

function formatRecallResults(hits: MemoryRetrievalHit[]): string {
	if (hits.length === 0) return "No matching memories found.";
	return hits.map((hit, index) => formatRecallHit(hit, index + 1)).join("\n\n");
}

function formatRecallHit(hit: MemoryRetrievalHit, ordinal: number): string {
	const chunk = hit.chunk;
	const lines = [
		`${ordinal}. id=${hit.id} type=${memoryTypeLabel(chunk)} score=${hit.score.toFixed(4)}`,
		...compactContextLines(chunk),
		`preview: ${previewText(chunk.snippet || chunk.text, MAX_TEXT_PREVIEW_CHARS)}`,
	];
	return lines.join("\n");
}

function formatOpenChunk(chunk: StoredMemoryChunk): string {
	const lines = [
		`id=${chunk.id} type=${memoryTypeLabel(chunk)}`,
		...compactContextLines(chunk),
		...openSourceLines(chunk),
		`stored=${formatUnixTimestamp(chunk.createdAt)} updated=${formatUnixTimestamp(chunk.updatedAt)}`,
		"",
		chunk.text,
	];
	return lines.join("\n");
}

function memoryTypeLabel(chunk: StoredMemoryChunk): string {
	if (chunk.corpus === "diary_chunk") return "diary";
	if (chunk.corpus === "lcm_record") return "conversation";
	if (chunk.corpus === "lcm_summary") return "conversation_summary";
	if (chunk.corpus === "atomic_fact") return "fact";
	return chunk.corpus;
}

function compactContextLines(chunk: StoredMemoryChunk): string[] {
	const lines: string[] = [];
	const happenedAt = metadataString(chunk.metadata, "happenedAt") ?? metadataString(chunk.metadata, "timestamp");
	const date = metadataString(chunk.metadata, "date");
	const heading = metadataString(chunk.metadata, "heading");
	if (happenedAt) lines.push(`when=${happenedAt}`);
	else if (date) lines.push(`when=${date}`);
	if (heading) lines.push(`title=${previewText(heading, MAX_CONTEXT_LABEL_CHARS)}`);
	return lines;
}

function openSourceLines(chunk: StoredMemoryChunk): string[] {
	const sources =
		chunk.sources.length > 0
			? chunk.sources
			: [{ sourceId: chunk.sourceId, sourceRef: chunk.sourceRef, chunkIndex: chunk.chunkIndex }];
	const labels = sources
		.map((source) => source.sourceRef ?? source.sourceId)
		.filter((value): value is string => !!value)
		.map((value) => previewText(value, MAX_SOURCE_LABEL_CHARS));
	return labels.length ? [`sources=${Array.from(new Set(labels)).join("; ")}`] : [];
}

function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function previewText(text: string, maxLength: number): string {
	const normalized = text.replaceAll(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatUnixTimestamp(value: number): string {
	const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
	return new Date(milliseconds).toISOString();
}

export const __memoryToolsTest = {
	formatUnixTimestamp,
	formatOpenChunk,
	formatRecallResults,
	previewText,
};
