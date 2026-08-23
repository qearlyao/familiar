import { readFile } from "node:fs/promises";
import type { IncomingAttachment } from "../media/inbound-attachments.js";
import type { InboundMessageInput } from "../runtime/conversation-runtime.js";
import type { OneBotClient } from "./onebot.js";

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
		} else if (segment.type === "record") {
			// Voice bytes are fetched with the OneBot get_record action in the daemon, then
			// transcribed like any other audio attachment. Some servers also put a URL on the
			// segment itself; prefer that and skip the get_record round-trip — but only for web
			// schemes, since file:// and friends would make fetch throw instead.
			const url = webUrl(data.url);
			if (url) {
				attachments.push({
					url,
					name: typeof data.file === "string" ? data.file : undefined,
					source: "qq",
				});
			} else if (typeof data.file === "string" && data.file) {
				attachments.push({ kind: "record", file: data.file, name: data.file });
			} else {
				parts.push("[record]");
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

/** Fetches a `record` segment's audio via OneBot's get_record action. */
export async function resolveQqRecord(client: OneBotClient, ref: QqRecordRef): Promise<IncomingAttachment> {
	const data = (await client.callAction<Record<string, unknown>>("get_record", {
		file: ref.file,
		out_format: "mp3",
	})) as Record<string, unknown>;

	const url = webUrl(data.url);
	const encoded =
		typeof data.file === "string" && data.file.startsWith("base64://")
			? data.file.slice("base64://".length)
			: undefined;
	const buffer = encoded ? Buffer.from(encoded, "base64") : undefined;
	if (!url && !buffer) {
		// Some OneBot servers hand back a path on their own disk instead of downloadable bytes.
		// That only works when the daemon runs on the same host as the server; try it and let a
		// read failure surface as the raw error.
		const localPath = localFilePath(data.file);
		if (localPath) {
			return {
				name: ref.name,
				mimeType: "audio/mpeg",
				source: "qq",
				buffer: await readFile(localPath),
			};
		}
		const file = typeof data.file === "string" ? data.file : undefined;
		throw new Error(
			`OneBot get_record returned no downloadable audio${file ? ` (${file})` : ""}; ` +
				"record transcripts need a server that returns base64 or a URL",
		);
	}
	return {
		name: ref.name,
		mimeType: url ? undefined : "audio/mpeg",
		source: "qq",
		...(url ? { url } : { buffer }),
	};
}
