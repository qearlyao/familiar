import { readFile } from "node:fs/promises";

import type { ChatChannelRef, StoredAttachment } from "../conversation/chat-log.js";
import type { OneBotClient } from "./onebot.js";

const MAX_CHUNK_CHARS = 3000;

type QqSegment =
	| { type: "text"; data: { text: string } }
	| { type: "image"; data: { file: string } }
	| { type: "record"; data: { file: string } };

export function chunkQqText(text: string): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > MAX_CHUNK_CHARS) {
		let cut = rest.lastIndexOf("\n", MAX_CHUNK_CHARS);
		if (cut <= 0) cut = MAX_CHUNK_CHARS;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest) chunks.push(rest);
	return chunks;
}

// Image and audio attachments are sent as OneBot segments; video and files stay visible in the WebUI only.
async function mediaSegments(attachments: StoredAttachment[]): Promise<QqSegment[]> {
	const segments: QqSegment[] = [];
	for (const attachment of attachments) {
		if (!attachment.localPath) continue;
		if (attachment.kind !== "image" && attachment.kind !== "audio") continue;
		const data = await readFile(attachment.localPath);
		const file = `base64://${data.toString("base64")}`;
		segments.push(
			attachment.kind === "image" ? { type: "image", data: { file } } : { type: "record", data: { file } },
		);
	}
	return segments;
}

export async function sendQqMessage(
	client: OneBotClient,
	ref: ChatChannelRef,
	text: string,
	attachments: StoredAttachment[] = [],
): Promise<string[]> {
	// silent replies pass empty text; non-silent text is already normalized upstream by parseOutboundReply
	const chunks = chunkQqText(text.trim());
	const media = await mediaSegments(attachments);
	const payloads: QqSegment[][] = chunks.map((chunk) => [{ type: "text", data: { text: chunk } }]);
	if (media.length > 0) {
		const last = payloads[payloads.length - 1];
		if (last) last.push(...media);
		else payloads.push(media);
	}
	const messageIds: string[] = [];
	for (const message of payloads) {
		const data =
			ref.scope === "dm"
				? await client.callAction<{ message_id?: number | string }>("send_private_msg", {
						user_id: Number(ref.channelId),
						message,
					})
				: await client.callAction<{ message_id?: number | string }>("send_group_msg", {
						group_id: Number(ref.channelId),
						message,
					});
		if (data?.message_id !== undefined) messageIds.push(String(data.message_id));
	}
	return messageIds;
}
