import type { ChunkIndexer } from "../index/chunk-indexer.js";
import { estimateTextTokens, selectRetainedSummaries } from "./context.js";
import { indexLcmSummaries } from "./indexer.js";
import type { LcmStore } from "./store.js";
import { capSummaryText, type LcmSummarizer } from "./summarizer.js";
import type { StoredLcmSummary } from "./types.js";

export interface LcmCondenseConfig {
	condenseGroupSize: number;
	maxSummaryDepth: number;
	leafTargetTokens: number;
}

export interface LcmCondenseOptions {
	segmentId: string;
	depth: number;
	store: LcmStore;
	summarizer: LcmSummarizer;
	config: LcmCondenseConfig;
	candidateIds?: readonly number[];
	indexer?: ChunkIndexer;
	signal?: AbortSignal;
}

export async function condense(input: LcmCondenseOptions): Promise<StoredLcmSummary[]> {
	const groupSize = positiveInteger(input.config.condenseGroupSize, "condenseGroupSize");
	const maxDepth = positiveInteger(input.config.maxSummaryDepth, "maxSummaryDepth");
	if (input.depth >= maxDepth) return [];

	const children = input.store
		.listSummaries(input.segmentId)
		.filter(
			(summary) =>
				summary.depth === input.depth &&
				summary.status === "ready" &&
				(input.candidateIds === undefined || input.candidateIds.includes(summary.id)) &&
				input.store.getSummaryChildren(summary.id).length === 0,
		)
		.sort(compareCoverage);

	const created: StoredLcmSummary[] = [];
	for (let index = 0; index + groupSize <= children.length; index += groupSize) {
		const group = children.slice(index, index + groupSize);
		const coversFromRecordId = minNullable(group.map((summary) => summary.coversFromRecordId));
		const coversToRecordId = maxNullable(group.map((summary) => summary.coversToRecordId));
		const text = capSummaryText(
			await summarizeCondensedGroup({
				group,
				targetTokens: input.config.leafTargetTokens,
				depth: input.depth + 1,
				summarizer: input.summarizer,
				signal: input.signal,
			}),
			input.config.leafTargetTokens,
		);
		const id = input.store.insertSummary({
			segmentId: input.segmentId,
			depth: input.depth + 1,
			status: "ready",
			text,
			coversFromRecordId,
			coversToRecordId,
			source: {
				sourceType: "manual",
				sourceRef: `lcm_condense:d${input.depth + 1}:${group.map((summary) => summary.id).join("-")}`,
			},
			sourceItems: group.map((summary) => ({ sourceRef: `lcm_summary:${summary.id}` })),
			parents: group.map((summary) => summary.id),
			metadata: {
				source: "condense",
				childDepth: input.depth,
				childSummaryIds: group.map((summary) => summary.id),
				...coverageMetadataFromSummaries(group),
			},
		});
		const summary = input.store.getSummary(id);
		if (summary) {
			created.push(summary);
			if (input.indexer) {
				await indexLcmSummaries({ indexer: input.indexer, summaries: [summary], signal: input.signal }).catch(
					(error) => console.error("memory LCM condensed summary indexing failed", error),
				);
			}
		}
	}

	if (created.length > 0 && input.depth + 1 < maxDepth) {
		created.push(
			...(await condense({
				...input,
				depth: input.depth + 1,
				candidateIds: created.map((summary) => summary.id),
			})),
		);
	}
	return created;
}

export function renderCondensedSummariesForContext(summaries: readonly StoredLcmSummary[]): StoredLcmSummary[] {
	return selectRetainedSummaries(summaries);
}

function compareCoverage(a: StoredLcmSummary, b: StoredLcmSummary): number {
	return (
		(a.coversFromRecordId ?? Number.MAX_SAFE_INTEGER) - (b.coversFromRecordId ?? Number.MAX_SAFE_INTEGER) ||
		(a.coversToRecordId ?? Number.MAX_SAFE_INTEGER) - (b.coversToRecordId ?? Number.MAX_SAFE_INTEGER) ||
		a.id - b.id
	);
}

async function summarizeCondensedGroup(input: {
	group: StoredLcmSummary[];
	targetTokens: number;
	depth: number;
	summarizer: LcmSummarizer;
	signal?: AbortSignal;
}): Promise<string> {
	const text = renderCondensedSummaryInput(input.group);
	if (input.summarizer.summarizeCondensed) {
		return input.summarizer.summarizeCondensed(
			{
				text,
				targetTokens: input.targetTokens,
				depth: input.depth,
				childSummaryCount: input.group.length,
			},
			input.signal,
		);
	}
	return input.summarizer.summarizeLeaf(
		{
			text,
			targetTokens: input.targetTokens,
			mode: "normal",
		},
		input.signal,
	);
}

function renderCondensedSummaryInput(group: readonly StoredLcmSummary[]): string {
	return group
		.map((summary) =>
			[
				`<summary id="${summary.id}" depth="${summary.depth}" from="${summary.coversFromRecordId ?? ""}" to="${
					summary.coversToRecordId ?? ""
				}" tokens="${estimateTextTokens(summary.text)}">`,
				formatSummaryTimeRange(summary),
				summary.text,
				"</summary>",
			]
				.filter(Boolean)
				.join("\n"),
		)
		.join("\n\n");
}

function formatSummaryTimeRange(summary: StoredLcmSummary): string {
	const from = metadataString(summary.metadata?.coverageFromHappenedAt ?? summary.metadata?.timestamp);
	const to = metadataString(summary.metadata?.coverageToHappenedAt ?? summary.metadata?.timestamp);
	if (!from && !to) return "";
	return `[time_range ${from ?? "unknown"} - ${to ?? "unknown"}]`;
}

function metadataString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function minNullable(values: Array<number | null>): number | null {
	const present = values.filter((value): value is number => value !== null);
	return present.length === 0 ? null : Math.min(...present);
}

function maxNullable(values: Array<number | null>): number | null {
	const present = values.filter((value): value is number => value !== null);
	return present.length === 0 ? null : Math.max(...present);
}

function coverageMetadataFromSummaries(group: readonly StoredLcmSummary[]): Record<string, string> {
	const from = firstValidTime(
		group.map((summary) => summary.metadata?.coverageFromHappenedAt ?? summary.metadata?.timestamp),
	);
	const to = lastValidTime(
		group.map((summary) => summary.metadata?.coverageToHappenedAt ?? summary.metadata?.timestamp),
	);
	return {
		...(from ? { coverageFromHappenedAt: from } : {}),
		...(to ? { coverageToHappenedAt: to, timestamp: to } : {}),
	};
}

function firstValidTime(values: readonly unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
	}
	return null;
}

function lastValidTime(values: readonly unknown[]): string | null {
	for (let index = values.length - 1; index >= 0; index -= 1) {
		const value = values[index];
		if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
	}
	return null;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be an integer >= 1`);
	return value;
}
