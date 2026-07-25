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
	| { kind: "text"; text: string; signature?: string }
	| { kind: "tool_call"; toolCallId: string; toolName: string; arguments: unknown; signature?: string }
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

export type LcmSummarySnapshot = Array<{
	id: number;
	kind: LcmRecordKind;
	happened_at: string;
	role: string | null;
	text: string;
	parts: LcmRecordPart[] | null;
	attachments: LcmAttachmentNote[] | null;
}>;

export interface LcmSummaryParentSnapshot {
	summaryId: number;
	depth: number;
	text: string;
	coversFromRecordId: number | null;
	coversToRecordId: number | null;
	snapshot: LcmSummarySnapshot | LcmSummaryParentSnapshot[] | null;
	parents: LcmSummaryParentSnapshot[];
}

export interface LcmSummarySourceInput {
	recordId?: number | null;
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
	parents?: number[];
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
	snapshot: LcmSummarySnapshot | LcmSummaryParentSnapshot[] | null;
	parents: number[];
	createdAt: number;
	updatedAt: number;
}

export interface StoredLcmSummarySource {
	summaryId: number;
	ord: number;
	recordId: number | null;
	sourceRef: string | null;
	snapshot: Record<string, unknown> | null;
}

export interface LcmContextItemInput {
	summaryId: number;
	fingerprint: string;
	happenedAt: string | null;
}

export interface StoredLcmContextItem extends LcmContextItemInput {
	sessionKey: string;
	ordinal: number;
	updatedAt: number;
}

export interface StoredLcmSessionState {
	sessionKey: string;
	compactionDebt: number;
	cacheTouchedAt: number | null;
	updatedAt: number | null;
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
	indexDeletes: LcmIndexDeleteRef[];
}
