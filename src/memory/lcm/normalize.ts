import type { ChatLogRecord, StoredAgentEvent, StoredAttachment } from "../../chat-log.js";
import type {
	LcmAttachmentNote,
	LcmRecordInput,
	LcmRecordPart,
	LcmSegmentInput,
	LcmSourceProvenance,
} from "./types.js";

export interface NormalizeChatRecordsOptions {
	segmentId: string;
	sessionId?: string | null;
	channelKey?: string | null;
	sourcePath?: string | null;
}

export interface NormalizedLcmBatch {
	segments: LcmSegmentInput[];
	records: LcmRecordInput[];
}

export function normalizeChatRecords(
	chatRecords: readonly ChatLogRecord[],
	options: NormalizeChatRecordsOptions,
): NormalizedLcmBatch {
	const segments = new Map<string, LcmSegmentInput>();
	const records: LcmRecordInput[] = [];
	const sortedRecords = [...chatRecords].sort((a, b) => a.recordId - b.recordId);
	const assistantEventsByJob = collectAssistantEvents(sortedRecords);

	for (const record of sortedRecords) {
		const segmentId = options.segmentId;
		if (!segments.has(segmentId)) {
			segments.set(segmentId, {
				id: segmentId,
				sessionId: options.sessionId ?? null,
				channelKey: options.channelKey ?? null,
				startedAt: record.ts,
			});
		}

		const source = chatRecordSource(record, options.sourcePath);
		const common = {
			segmentId,
			happenedAt: record.ts,
			sessionId: options.sessionId ?? null,
			channelKey: options.channelKey ?? null,
			channelId: record.channelId,
			source,
		};

		if (record.type === "inbound") {
			const text = withAttachmentNotes(record.text, attachmentNotes(record.attachments));
			if (text) {
				records.push({
					...common,
					kind: "user",
					text,
					attachments: attachmentNotes(record.attachments),
					metadata: { authorId: record.authorId, authorName: record.authorName ?? null },
				});
			}
			continue;
		}

		if (record.type === "outbound" && !record.silent) {
			const notes = attachmentNotes(record.attachments ?? []);
			const parts = assistantParts(record, assistantEventsByJob.get(record.jobId ?? ""));
			appendAssistantFinalText(parts, withAttachmentNotes(record.text, notes));
			const text = flattenLcmRecordParts(parts);
			if (text) {
				records.push({
					...common,
					kind: "assistant",
					text,
					parts: parts.length ? parts : undefined,
					jobId: record.jobId ?? null,
					attachments: notes,
					metadata: { messageIds: record.messageIds, replyToMessageId: record.replyToMessageId ?? null },
				});
			}
			continue;
		}

		if (record.type === "agent_event" && record.event.type === "tool_execution_end") {
			const parts: LcmRecordPart[] = [
				{
					kind: "tool_result",
					toolCallId: record.event.toolCallId,
					toolName: record.event.toolName,
					output: record.event.result,
					...(record.event.isError ? { isError: true } : {}),
				},
			];
			records.push({
				...common,
				kind: "tool",
				text: flattenLcmRecordParts(parts),
				parts,
				jobId: record.jobId,
				metadata: { messageId: record.messageId },
			});
			continue;
		}

		if (record.type === "control" && record.command === "new") {
			records.push({
				...common,
				kind: "boundary",
				text: record.text || "/new",
				metadata: { command: record.command, args: record.args ?? null, authorId: record.authorId },
			});
			continue;
		}

		if (record.type === "runtime" && record.event === "reset") {
			records.push({
				...common,
				kind: "boundary",
				text: record.detail || "runtime reset",
				metadata: { event: record.event },
			});
		}
	}

	return { segments: [...segments.values()], records };
}

export function flattenLcmRecordParts(parts: readonly LcmRecordPart[]): string {
	return parts
		.map((part) => {
			if (part.kind === "text") return part.text.trim();
			if (part.kind === "thinking") return part.text.trim() ? `[thinking] ${part.text.trim()}` : "";
			if (part.kind === "tool_call") return `[tool_call: ${part.toolName}(${briefJson(part.arguments)})]`;
			return `[tool_result: ${part.toolName} -> ${briefJson(part.output)}]`;
		})
		.filter(Boolean)
		.join("\n");
}

function collectAssistantEvents(records: readonly ChatLogRecord[]): Map<string, StoredAgentEvent[]> {
	const byJob = new Map<string, StoredAgentEvent[]>();
	for (const record of records) {
		if (record.type !== "agent_event") continue;
		const events = byJob.get(record.jobId) ?? [];
		events.push(record.event);
		byJob.set(record.jobId, events);
	}
	return byJob;
}

function assistantParts(
	record: Extract<ChatLogRecord, { type: "outbound" }>,
	events: StoredAgentEvent[] | undefined,
): LcmRecordPart[] {
	const parts: LcmRecordPart[] = [];
	if (record.thinking?.trim()) appendThinkingPart(parts, record.thinking);
	for (const event of events ?? []) {
		if (event.type !== "message_update") continue;
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type === "text_delta") {
			appendTextPart(parts, assistantEvent.delta);
		} else if (assistantEvent.type === "thinking_delta") {
			appendThinkingPart(parts, assistantEvent.delta);
		} else if (assistantEvent.type === "toolcall_end") {
			parts.push({
				kind: "tool_call",
				toolCallId: assistantEvent.toolCall.id,
				toolName: assistantEvent.toolCall.name,
				arguments: assistantEvent.toolCall.arguments,
			});
		}
	}
	return parts;
}

function appendTextPart(parts: LcmRecordPart[], text: string): void {
	if (!text) return;
	const previous = parts.at(-1);
	if (previous?.kind === "text") {
		previous.text += text;
		return;
	}
	parts.push({ kind: "text", text });
}

function appendAssistantFinalText(parts: LcmRecordPart[], text: string): void {
	const normalized = text.trim();
	if (!normalized) return;
	const existingText = parts
		.filter((part): part is Extract<LcmRecordPart, { kind: "text" }> => part.kind === "text")
		.map((part) => part.text)
		.join("")
		.trim();
	if (existingText === normalized) return;
	appendTextPart(parts, text);
}

function appendThinkingPart(parts: LcmRecordPart[], text: string): void {
	if (!text) return;
	const previous = parts.at(-1);
	if (previous?.kind === "thinking" && !previous.signature) {
		previous.text += text;
		return;
	}
	parts.push({ kind: "thinking", text });
}

function briefJson(value: unknown, maxLength = 160): string {
	let text: string;
	if (typeof value === "string") text = value;
	else {
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
	}
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}...` : compact;
}

function chatRecordSource(record: ChatLogRecord, sourcePath?: string | null): LcmSourceProvenance {
	const messageId =
		"messageId" in record && typeof record.messageId === "string"
			? record.messageId
			: "messageIds" in record
				? record.messageIds[0]
				: undefined;
	return {
		sourceType: "chat",
		sourcePath: sourcePath ?? null,
		sourceRecordId: record.recordId,
		sourceMessageId: messageId ?? null,
		sourceRef: sourcePath ? `${sourcePath}#${record.recordId}` : `chat:${record.recordId}`,
	};
}

function attachmentNotes(attachments: readonly StoredAttachment[]): LcmAttachmentNote[] | null {
	const notes = attachments
		.map((attachment) => {
			const derivedText = attachment.derived?.text?.text.trim();
			const imageNote = attachment.derived?.image?.note?.trim();
			const note: LcmAttachmentNote = {
				id: attachment.id,
				name: attachment.name,
				kind: attachment.kind,
				mimeType: attachment.mimeType,
				text: derivedText || undefined,
				note: imageNote || undefined,
				sourceRef: attachment.localPath ?? attachment.remoteUrl ?? attachment.sourceUrl,
			};
			return note.text || note.note || note.name ? note : null;
		})
		.filter((item): item is LcmAttachmentNote => item !== null);
	return notes.length ? notes : null;
}

function withAttachmentNotes(text: string, notes: LcmAttachmentNote[] | null): string {
	const trimmed = text.trim();
	const usefulNotes = (notes ?? [])
		.map((note) => note.text || note.note || (note.name ? `Attachment: ${note.name}` : ""))
		.filter((note) => note.trim());
	if (usefulNotes.length === 0) return trimmed;
	return [trimmed, ...usefulNotes].filter(Boolean).join("\n");
}
