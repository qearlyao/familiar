import { readFile } from "node:fs/promises";
import type { ChatLogRecord } from "../conversation/chat-log.js";
import type { IncomingAttachment } from "../media/inbound-attachments.js";
import type { InboundMessageInput } from "../runtime/conversation-runtime.js";
import type { OneBotClient } from "./onebot.js";

/** Max chars of quoted text surfaced to the agent; longer quotes are elided. */
const QUOTE_MAX_CHARS = 300;

interface QqMessageSegment {
	type?: string;
	data?: Record<string, unknown>;
}

/** OneBot segment URLs are only safe to hand to fetch when they use the web schemes. */
function webUrl(value: unknown): string | undefined {
	return typeof value === "string" && /^https?:\/\//.test(value) ? value : undefined;
}

/** A filesystem path on the same host as the daemon (OneBot servers often return these verbatim). */
function localFilePath(value: unknown): string | undefined {
	return typeof value === "string" && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) ? value : undefined;
}

/** A `record` segment whose audio bytes still need fetching via the OneBot `get_record` action. */
export interface QqRecordRef {
	kind: "record";
	/** The OneBot `file` identifier (a filename or path on the server) to fetch the audio with. */
	file: string;
	name?: string;
}

export type ResolvableQqAttachment = IncomingAttachment | QqRecordRef;

export function isQqRecordRef(attachment: ResolvableQqAttachment): attachment is QqRecordRef {
	return (attachment as QqRecordRef).kind === "record";
}

export interface ParsedQqMessage {
	messageType: "private" | "group";
	/** Owner QQ号 for private chats, 群号 for groups. */
	channelId: string;
	/** The `message_id` quoted by the inbound `reply` segment, when present. */
	replyToMessageId?: string;
	input: Omit<InboundMessageInput, "attachments">;
	attachments: ResolvableQqAttachment[];
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
	const attachments: ResolvableQqAttachment[] = [];
	let mentionedBot = false;
	let replyToMessageId: string | undefined;
	for (const segment of segments as QqMessageSegment[]) {
		const data = segment.data ?? {};
		if (segment.type === "text") {
			if (typeof data.text === "string") parts.push(data.text);
		} else if (segment.type === "reply") {
			// The reply segment only points at the quoted message; the adapter resolves its text
			// separately and never renders the segment itself into the visible message.
			if (typeof data.id === "string" && data.id) replyToMessageId = data.id;
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
		} else if (segment.type === "record") {
			// Voice bytes should always go through get_record when a file identifier exists,
			// even if the segment also carries a url. Some implementations put a non-http url
			// or a path-like url there that looks usable but isn't fetchable.
			if (typeof data.file === "string" && data.file) {
				attachments.push({ kind: "record", file: data.file, name: data.file });
			} else {
				const url = webUrl(data.url);
				if (url) {
					attachments.push({
						url,
						name: typeof data.file === "string" ? data.file : undefined,
						source: "qq",
					});
				} else {
					parts.push("[record]");
				}
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
		replyToMessageId,
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

/** Fetches a `record` segment's audio via OneBot's get_record action. */
export async function resolveQqRecord(client: OneBotClient, ref: QqRecordRef): Promise<IncomingAttachment> {
	const data = (await client.callAction<Record<string, unknown>>("get_record", {
		file: ref.file,
		out_format: "mp3",
	})) as Record<string, unknown>;

	// Prefer the server-converted bytes over a URL: some servers return both a base64 field and
	// a url that is not actually fetchable over http(s), so the bytes win when present.
	const encoded =
		typeof data.base64 === "string"
			? data.base64
			: typeof data.file === "string" && data.file.startsWith("base64://")
				? data.file.slice("base64://".length)
				: undefined;
	const buffer = encoded ? Buffer.from(encoded, "base64") : undefined;
	if (buffer) {
		return { name: "qq-record.mp3", mimeType: "audio/mpeg", source: "qq", buffer };
	}
	const url = webUrl(data.url);
	if (url) {
		return { name: "qq-record.mp3", mimeType: "audio/mpeg", source: "qq", url };
	}
	// Some OneBot servers hand back a path on their own disk instead of downloadable bytes.
	// That only works when the daemon runs on the same host as the server; try it and let a
	// read failure surface as the raw error.
	const localPath = localFilePath(data.file);
	if (localPath) {
		return { name: "qq-record.mp3", mimeType: "audio/mpeg", source: "qq", buffer: await readFile(localPath) };
	}
	const file = typeof data.file === "string" ? data.file : undefined;
	throw new Error(
		`OneBot get_record returned no downloadable audio${file ? ` (${file})` : ""}; ` +
			"record transcripts need a server that returns base64 or a URL",
	);
}

function elideQuote(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	return trimmed.length > QUOTE_MAX_CHARS ? `${trimmed.slice(0, QUOTE_MAX_CHARS)}…` : trimmed;
}

/**
 * Resolves an inbound `reply` segment's quoted message to plain text for the agent.
 *
 * Quotes of the bot's own messages are found in the local chat log (no network round-trip, and
 * attachments are already stripped). Quotes of other users' messages fall back to OneBot's
 * `get_msg` action; its response segments yield only their `text` parts, never attachments.
 * Returns `undefined` when the quote can't be resolved (unknown id, unsupported server, or an
 * attachment-only message) so the caller can leave the message unchanged.
 */
export async function resolveQqQuote(
	client: OneBotClient,
	replyToMessageId: string,
	records: readonly ChatLogRecord[],
): Promise<string | undefined> {
	const local = records.find((record) => record.type === "outbound" && record.messageIds.includes(replyToMessageId));
	if (local?.type === "outbound") return elideQuote(local.text);

	try {
		const data = await client.callAction<{ message?: unknown }>("get_msg", { message_id: Number(replyToMessageId) });
		if (!Array.isArray(data.message)) return undefined;
		const parts: string[] = [];
		for (const segment of data.message as QqMessageSegment[]) {
			if (segment.type === "text" && typeof segment.data?.text === "string") parts.push(segment.data.text);
		}
		return elideQuote(parts.join(""));
	} catch {
		return undefined;
	}
}
