import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import type { Message, MessageCreateOptions } from "discord.js";
import type { Config } from "../config/index.js";
import type { StoredAttachment } from "../conversation/chat-log.js";
import { parseAgentReply as parseSilentMarker } from "../runtime/silent-marker.js";
import type { DiscordChatChannel } from "./channel.js";
import { chunkDiscord } from "./chunking.js";

const NEWLINE_BURST_DELAY_MS = 500;
const DISCORD_ATTACHMENT_SEND_TIMEOUT_MS = 120_000;
const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

interface DiscordAttachmentFile {
	data: Buffer;
	name: string;
	contentType: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function delayBetweenBurstChunks(config: Config, channel: DiscordChatChannel): Promise<void> {
	if (config.discord.chunkMode !== "newline") return;
	if (channel.isSendable()) {
		void channel.sendTyping().catch(() => undefined);
	}
	await sleep(NEWLINE_BURST_DELAY_MS);
}

export function normalizeOutboundText(text: string): string {
	return text.trim() || "(empty response)";
}

function fallbackMimeType(name: string): string {
	return extname(name).toLowerCase() === ".mp3" ? "audio/mpeg" : "application/octet-stream";
}

export async function buildDiscordAttachmentFiles(attachments: StoredAttachment[]): Promise<DiscordAttachmentFile[]> {
	const files: DiscordAttachmentFile[] = [];
	for (const attachment of attachments) {
		if (!attachment.localPath) continue;
		const data = await readFile(attachment.localPath);
		files.push({
			name: attachment.name,
			data,
			contentType: attachment.mimeType || fallbackMimeType(attachment.name),
		});
	}
	return files;
}

export async function postDiscordAttachments(
	botToken: string,
	channelId: string,
	attachments: StoredAttachment[],
): Promise<string[]> {
	const files = await buildDiscordAttachmentFiles(attachments);
	if (files.length === 0) return [];
	const form = new FormData();
	form.set("payload_json", JSON.stringify({}));
	for (const [index, file] of files.entries()) {
		const bytes = new Uint8Array(file.data.byteLength);
		bytes.set(file.data);
		form.set(`files[${index}]`, new Blob([bytes], { type: file.contentType }), file.name);
	}
	const response = await fetch(`${DISCORD_API_BASE_URL}/channels/${channelId}/messages`, {
		method: "POST",
		headers: { Authorization: `Bot ${botToken}` },
		body: form,
		signal: AbortSignal.timeout(DISCORD_ATTACHMENT_SEND_TIMEOUT_MS),
	});
	const data = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
	if (!response.ok || !data.id) throw new Error(data.message || `Discord attachment send failed (${response.status})`);
	return [data.id];
}

export function parseOutboundReply(text: string): { text: string; silent: boolean } {
	const parsed = parseSilentMarker(text);
	if (parsed.silent) return parsed;
	return { text: normalizeOutboundText(parsed.text), silent: false };
}

async function sendChunkedMessage(
	config: Config,
	botToken: string,
	channel: DiscordChatChannel,
	channelId: string,
	normalizedText: string,
	attachments: StoredAttachment[],
	sendChunk: (chunk: string, index: number) => Promise<Message>,
): Promise<string[]> {
	const chunks = chunkDiscord(config, normalizedText);
	const sentIds: string[] = [];
	for (const [index, chunk] of chunks.entries()) {
		if (index > 0) await delayBetweenBurstChunks(config, channel);
		const sent = await sendChunk(chunk, index);
		sentIds.push(sent.id);
	}
	const attachmentIds = await sendDiscordAttachments(botToken, channelId, attachments);
	return [...sentIds, ...attachmentIds];
}

export async function sendReply(
	config: Config,
	botToken: string,
	message: Message,
	text: string,
	replyToMessageId?: string,
	attachments: StoredAttachment[] = [],
): Promise<string[]> {
	const normalizedText = normalizeOutboundText(text);
	return sendChunkedMessage(
		config,
		botToken,
		message.channel,
		message.channelId,
		normalizedText,
		attachments,
		async (chunk, index) => {
			if (!message.channel.isSendable()) {
				throw new Error(`Discord channel is not sendable: ${message.channelId}`);
			}
			if (index === 0 && config.discord.replyMode === "reply") {
				try {
					const replyTarget = replyToMessageId || message.id;
					const options: MessageCreateOptions = { content: chunk, reply: { messageReference: replyTarget } };
					return await message.channel.send(options);
				} catch (error) {
					console.error("Discord reply failed; falling back to channel send", error);
				}
			}
			return message.channel.send(chunk);
		},
	);
}

export async function sendChannelMessage(
	config: Config,
	botToken: string,
	channel: DiscordChatChannel,
	text: string,
	attachments: StoredAttachment[] = [],
): Promise<string[]> {
	if (!channel.isSendable()) {
		throw new Error("Discord channel is not sendable");
	}
	const normalizedText = normalizeOutboundText(text);
	return sendChunkedMessage(config, botToken, channel, channel.id, normalizedText, attachments, (chunk) =>
		channel.send(chunk),
	);
}

export async function sendDiscordAttachments(
	botToken: string,
	channelId: string,
	attachments: StoredAttachment[],
): Promise<string[]> {
	if (attachments.length === 0) return [];
	try {
		return await postDiscordAttachments(botToken, channelId, attachments);
	} catch (error) {
		console.error("Discord attachment send failed", error);
		return [];
	}
}
