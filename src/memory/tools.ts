import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";

import type { Config } from "../config.js";
import { createEmbeddingProvider } from "./index/embedding-provider.js";
import { type MemoryRetrievalHit, retrieveMemory } from "./index/retrieval.js";
import { MemoryIndexStore, type StoredMemoryChunk } from "./index/store.js";

const DEFAULT_RECALL_LIMIT = 8;
const MAX_TEXT_PREVIEW_CHARS = 700;
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
				description: "diary searches long-term diary memory; factual searches facts and conversation memory.",
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

interface MemoryRecallDetails {
	query: string;
	scope: MemoryRecallScope;
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
}

export function createMemoryTools(config: Config): AgentTool<any>[] {
	return [makeMemoryRecallTool(config), makeMemoryOpenTool(config)];
}

function makeMemoryRecallTool(config: Config): AgentTool<typeof memoryRecallSchema, MemoryRecallDetails> {
	return {
		name: "memory_recall",
		label: "Memory Recall",
		description:
			"Search Familiar's shared memory index. Returns concise chunk previews and ids; use memory_open for full text and metadata.",
		parameters: memoryRecallSchema,
		async execute(_toolCallId, input: MemoryRecallInput, signal?: AbortSignal) {
			const query = input.query.trim();
			if (!query) throw new Error("memory_recall query is required.");
			const scope = input.scope ?? "all";
			const limit = clampLimit(input.limit);
			const store = MemoryIndexStore.open(config);
			try {
				const embeddingProvider = createEmbeddingProvider(config);
				const hits = await retrieveMemory({
					query,
					store,
					embeddingProvider,
					scope: { corpora: MEMORY_SCOPE_CORPORA[scope] },
					limit,
					signal,
				});
				return {
					content: [{ type: "text", text: formatRecallResults(hits) }],
					details: {
						query,
						scope,
						limit,
						resultCount: hits.length,
						ids: hits.map((hit) => hit.id),
					},
				};
			} finally {
				store.close();
			}
		},
	};
}

function makeMemoryOpenTool(config: Config): AgentTool<typeof memoryOpenSchema, MemoryOpenDetails> {
	return {
		name: "memory_open",
		label: "Memory Open",
		description: "Open one stored memory chunk by id, returning its full text and metadata.",
		parameters: memoryOpenSchema,
		async execute(_toolCallId, input: MemoryOpenInput) {
			const id = Math.trunc(input.id);
			if (!Number.isInteger(input.id) || id < 1) throw new Error("memory_open id must be a positive integer.");
			const store = MemoryIndexStore.open(config);
			try {
				const chunk = store.getChunk(id);
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
					},
				};
			} finally {
				store.close();
			}
		},
	};
}

function clampLimit(value: number | undefined): number {
	if (value === undefined) return DEFAULT_RECALL_LIMIT;
	if (!Number.isInteger(value) || value < 1) throw new Error("memory_recall limit must be a positive integer.");
	return Math.min(value, 20);
}

function formatRecallResults(hits: MemoryRetrievalHit[]): string {
	if (hits.length === 0) return "No matching memories found.";
	return hits.map((hit, index) => formatRecallHit(hit, index + 1)).join("\n\n");
}

function formatRecallHit(hit: MemoryRetrievalHit, ordinal: number): string {
	const chunk = hit.chunk;
	const lines = [
		`${ordinal}. id=${hit.id} corpus=${chunk.corpus} score=${hit.score.toFixed(4)}`,
		`source=${formatSource(chunk)} chunk=${chunk.chunkIndex}`,
		`text: ${previewText(chunk.snippet || chunk.text, MAX_TEXT_PREVIEW_CHARS)}`,
	];
	const metadata = formatMetadata(chunk.metadata);
	if (metadata) lines.push(`metadata: ${metadata}`);
	return lines.join("\n");
}

function formatOpenChunk(chunk: StoredMemoryChunk): string {
	const lines = [
		`id=${chunk.id} corpus=${chunk.corpus}`,
		`source=${formatSource(chunk)} chunk=${chunk.chunkIndex}`,
		`createdAt=${formatUnixTimestamp(chunk.createdAt)} updatedAt=${formatUnixTimestamp(chunk.updatedAt)}`,
		"",
		chunk.text,
	];
	const metadata = formatMetadata(chunk.metadata);
	if (metadata) lines.push("", `metadata: ${metadata}`);
	return lines.join("\n");
}

function formatSource(chunk: StoredMemoryChunk): string {
	const parts = [
		chunk.sourceId ? `id:${chunk.sourceId}` : undefined,
		chunk.sourceRef ? `ref:${chunk.sourceRef}` : undefined,
	];
	return parts.filter(Boolean).join(" ") || "unknown";
}

function formatMetadata(metadata: Record<string, unknown> | null): string {
	return metadata ? JSON.stringify(metadata) : "";
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
