export type LcmRecordKind = "user" | "assistant" | "tool" | "note" | "boundary";
export type LcmSourceType = "chat" | "transcript" | "manual";
export type LcmSegmentStatus = "active" | "closed";
export type LcmSummaryStatus = "placeholder" | "ready";

export interface LcmSourceProvenance {
	sourceType: LcmSourceType;
	sourcePath?: string | null;
	sourceLine?: number | null;
	sourceRecordId?: number | string | null;
	sourceMessageId?: string | null;
	sourceRef?: string | null;
}

export interface LcmAttachmentNote {
	id?: string;
	name?: string;
	kind?: string;
	mimeType?: string;
	text?: string;
	note?: string;
	sourceRef?: string;
}

export type LcmRecordPart =
	| { kind: "text"; text: string }
	| { kind: "tool_call"; toolCallId: string; toolName: string; arguments: unknown }
	| { kind: "tool_result"; toolCallId: string; toolName: string; output: unknown; isError?: boolean }
	| { kind: "thinking"; text: string; signature?: string };

export interface LcmSegmentInput {
	id: string;
	sessionId?: string | null;
	channelKey?: string | null;
	startedAt?: string | null;
	boundarySource?: LcmSourceProvenance | null;
	metadata?: Record<string, unknown> | null;
}

export interface StoredLcmSegment {
	id: string;
	status: LcmSegmentStatus;
	sessionId: string | null;
	channelKey: string | null;
	startedAt: string;
	closedAt: string | null;
	rawPrunedAt: string | null;
	boundarySource: LcmSourceProvenance | null;
	metadata: Record<string, unknown> | null;
	createdAt: number;
	updatedAt: number;
}

export interface LcmRecordInput {
	segmentId: string;
	kind: LcmRecordKind;
	text?: string;
	parts?: LcmRecordPart[];
	happenedAt?: string | null;
	sessionId?: string | null;
	channelKey?: string | null;
	channelId?: string | null;
	jobId?: string | null;
	source: LcmSourceProvenance;
	attachments?: LcmAttachmentNote[] | null;
	metadata?: Record<string, unknown> | null;
}

export interface StoredLcmRecord {
	id: number;
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
	attachments: LcmAttachmentNote[] | null;
	metadata: Record<string, unknown> | null;
	createdAt: number;
	updatedAt: number;
}

export interface LcmSummarySourceInput {
	recordId?: number | null;
	summaryId?: number | null;
	sourceRef?: string | null;
	snapshot?: Record<string, unknown> | null;
}

export interface LcmSummaryInput {
	segmentId: string;
	depth: number;
	text?: string;
	status?: LcmSummaryStatus;
	pinned?: boolean;
	coversFromRecordId?: number | null;
	coversToRecordId?: number | null;
	source: LcmSourceProvenance;
	sourceItems?: LcmSummarySourceInput[];
	metadata?: Record<string, unknown> | null;
}

export interface StoredLcmSummary {
	id: number;
	summaryKey: string;
	segmentId: string;
	depth: number;
	status: LcmSummaryStatus;
	text: string;
	pinned: boolean;
	coversFromRecordId: number | null;
	coversToRecordId: number | null;
	source: LcmSourceProvenance;
	metadata: Record<string, unknown> | null;
	createdAt: number;
	updatedAt: number;
}

export interface StoredLcmSummarySource {
	summaryId: number;
	ord: number;
	recordId: number | null;
	sourceSummaryId: number | null;
	sourceRef: string | null;
	snapshot: Record<string, unknown> | null;
}

export interface LcmRetentionOptions {
	newSessionRetainDepth: number;
	activeSegmentId?: string | null;
	vacuum?: boolean;
}

export interface LcmIndexDeleteRef {
	corpus: "lcm_record" | "lcm_summary";
	sourceId: string;
}

export interface LcmRetentionReport {
	retainDepth: number;
	affectedSegments: string[];
	rawRecordsDeleted: number;
	summariesDeleted: number;
	recordFtsRowsDeleted: number;
	summaryFtsRowsDeleted: number;
	indexDeletes: LcmIndexDeleteRef[];
}
