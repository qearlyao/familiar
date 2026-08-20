import type { IncomingAttachment } from "../media/inbound-attachments.js";
import type { InboundMessageInput } from "../runtime/conversation-runtime.js";

interface QqMessageSegment {
	type?: string;
	data?: Record<string, unknown>;
}

export interface ParsedQqMessage {
	messageType: "private" | "group";
	/** Owner QQ号 for private chats, 群号 for groups. */
	channelId: string;
	input: Omit<InboundMessageInput, "attachments">;
	attachments: IncomingAttachment[];
}

export function parseQqMessageEvent(event: Record<string, unknown>, selfId: string): ParsedQqMessage {
	const messageType = event.message_type;
	if (messageType !== "private" && messageType !== "group") {
		throw new Error(`Unsupported QQ message_type: ${String(messageType)}`);
	}
	const segments = event.message;
	if (!Array.isArray(segments)) {
		throw new Error('QQ message is not a segment array; set messagePostFormat to "array" on the OneBot server');
	}
	const parts: string[] = [];
	const attachments: IncomingAttachment[] = [];
	let mentionedBot = false;
	for (const segment of segments as QqMessageSegment[]) {
		const data = segment.data ?? {};
		if (segment.type === "text") {
			if (typeof data.text === "string") parts.push(data.text);
		} else if (segment.type === "at") {
			if (String(data.qq) === selfId) mentionedBot = true;
			else parts.push(`@${String(data.qq ?? "")}`);
		} else if (segment.type === "image") {
			if (typeof data.url === "string" && data.url) {
				attachments.push({
					url: data.url,
					name: typeof data.file === "string" ? data.file : undefined,
					source: "qq",
				});
			} else {
				parts.push("[image]");
			}
		} else {
			parts.push(`[${segment.type ?? "unknown"}]`);
		}
	}
	const sender = (event.sender ?? {}) as Record<string, unknown>;
	const card = typeof sender.card === "string" && sender.card.trim() ? sender.card.trim() : undefined;
	const nickname = typeof sender.nickname === "string" && sender.nickname.trim() ? sender.nickname.trim() : undefined;
	const timeSeconds = Number(event.time);
	const messageId = String(event.message_id);
	return {
		messageType,
		channelId: messageType === "group" ? String(event.group_id) : String(event.user_id),
		attachments,
		input: {
			messageId,
			authorId: String(event.user_id),
			authorName: card ?? nickname,
			text: parts.join("").trim(),
			// OneBot doesn't flag bot senders — other bots read as regular members, which is the point of this adapter.
			isBot: false,
			mentionedBot,
			remoteTimestamp:
				Number.isFinite(timeSeconds) && timeSeconds > 0 ? new Date(timeSeconds * 1000).toISOString() : undefined,
			checkpoint: { messageId },
		},
	};
}
