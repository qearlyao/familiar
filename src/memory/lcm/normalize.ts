import type { ChatLogRecord, StoredAttachment } from "../../chat-log.js";
import type { LcmAttachmentNote, LcmRecordInput, LcmSegmentInput, LcmSourceProvenance } from "./types.js";

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
			const text = withAttachmentNotes(record.text, notes);
			if (text) {
				records.push({
					...common,
					kind: "assistant",
					text,
					jobId: record.jobId ?? null,
					attachments: notes,
					metadata: { messageIds: record.messageIds, replyToMessageId: record.replyToMessageId ?? null },
				});
			}
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
