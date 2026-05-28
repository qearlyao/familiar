import type {
	LcmRecordInput,
	LcmRecordKind,
	LcmRecordPart,
	LcmSourceProvenance,
	LcmSummaryInput,
	LcmSummarySourceInput,
	LcmSummaryStatus,
} from "../types.js";
import { stableHash } from "./serialization.js";

export function normalizeSource(source: LcmSourceProvenance): LcmSourceProvenance {
	return {
		sourceType: source.sourceType,
		sourcePath: source.sourcePath ?? null,
		sourceLine: source.sourceLine ?? null,
		sourceRecordId: source.sourceRecordId ?? null,
		sourceMessageId: source.sourceMessageId ?? null,
		sourceRef: source.sourceRef ?? null,
	};
}

export function normalizeRecordInput(input: LcmRecordInput): NormalizedRecordInput {
	const text = (input.text ?? "").trim();
	if (!text && input.kind !== "boundary") throw new Error("LCM record text must not be empty");
	const source = normalizeSource(input.source);
	const happenedAt = input.happenedAt ?? new Date().toISOString();
	const parts = input.parts?.length ? input.parts : null;
	const normalizedText = text || "Session boundary";
	return {
		segmentId: input.segmentId,
		kind: input.kind,
		text: normalizedText,
		parts,
		happenedAt,
		sessionId: input.sessionId ?? null,
		channelKey: input.channelKey ?? null,
		channelId: input.channelId ?? null,
		jobId: input.jobId ?? null,
		source,
		attachments: input.attachments?.length ? input.attachments : null,
		metadata: input.metadata ?? null,
		recordKey: computeLcmRecordKey({ ...input, happenedAt }),
	};
}

export function normalizeSummaryInput(input: LcmSummaryInput): NormalizedSummaryInput {
	const text = (input.text ?? "").trim();
	const source = normalizeSource(input.source);
	const status = input.status ?? (text ? "ready" : "placeholder");
	const normalizedText = text || "";
	return {
		segmentId: input.segmentId,
		depth: input.depth,
		status,
		text: normalizedText,
		pinned: input.pinned ?? false,
		coversFromRecordId: input.coversFromRecordId ?? null,
		coversToRecordId: input.coversToRecordId ?? null,
		source,
		sourceItems: input.sourceItems ?? [],
		parents: input.parents ?? [],
		metadata: input.metadata ?? null,
		summaryKey: stableHash({
			segmentId: input.segmentId,
			depth: input.depth,
			status,
			text: normalizedText,
			coversFromRecordId: input.coversFromRecordId ?? null,
			coversToRecordId: input.coversToRecordId ?? null,
			source,
			parents: input.parents ?? [],
		}),
	};
}

export function computeLcmRecordKey(input: LcmRecordInput): string {
	const text = (input.text ?? "").trim();
	if (!text && input.kind !== "boundary") throw new Error("LCM record text must not be empty");
	const parts = input.parts?.length ? input.parts : null;
	return stableHash({
		segmentId: input.segmentId,
		kind: input.kind,
		text: text || "Session boundary",
		parts,
		happenedAt: input.happenedAt ?? new Date().toISOString(),
		source: normalizeSource(input.source),
	});
}

export function dedupeSummaryParentIds(values: readonly number[]): number[] {
	const seen = new Set<number>();
	const result: number[] = [];
	for (const value of values) {
		if (!Number.isInteger(value) || value <= 0) throw new Error("LCM summary parents must be positive integer ids");
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

export interface NormalizedRecordInput {
	recordKey: string;
	segmentId: string;
	kind: LcmRecordKind;
	text: string;
	parts: LcmRecordPart[] | null;
	happenedAt: string;
	sessionId: string | null;
	channelKey: string | null;
	channelId: string | null;
	jobId: string | null;
	source: LcmSourceProvenance;
	attachments: LcmRecordInput["attachments"] | null;
	metadata: Record<string, unknown> | null;
}

export interface NormalizedSummaryInput {
	summaryKey: string;
	segmentId: string;
	depth: number;
	status: LcmSummaryStatus;
	text: string;
	pinned: boolean;
	coversFromRecordId: number | null;
	coversToRecordId: number | null;
	source: LcmSourceProvenance;
	sourceItems: LcmSummarySourceInput[];
	parents: number[];
	metadata: Record<string, unknown> | null;
}
