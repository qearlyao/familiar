import type { ChatLogRecord } from "../../conversation/chat-log.js";
import type { LcmRecordInput } from "./types.js";

export interface ChatBoundaryOptions {
	segmentId: string;
	sessionId?: string | null;
	channelKey?: string | null;
}

/** The chat log's only contribution to LCM: `/new` and reset boundaries. Turns come from the agent's messages. */
export function chatBoundaryRecord(record: ChatLogRecord, options: ChatBoundaryOptions): LcmRecordInput | null {
	const common = {
		segmentId: options.segmentId,
		kind: "boundary" as const,
		happenedAt: record.ts,
		sessionId: options.sessionId ?? null,
		channelKey: options.channelKey ?? null,
		channelId: record.channelId,
		source: {
			sourceType: "chat" as const,
			sourceRecordId: record.recordId,
			sourceMessageId: record.type === "control" ? (record.messageId ?? null) : null,
			sourceRef: `chat:${record.recordId}`,
		},
	};
	if (record.type === "control" && record.command === "new") {
		return {
			...common,
			text: record.text || "/new",
			metadata: { command: record.command, args: record.args ?? null, authorId: record.authorId },
		};
	}
	if (record.type === "runtime" && record.event === "reset") {
		return { ...common, text: record.detail || "runtime reset", metadata: { event: record.event } };
	}
	return null;
}
