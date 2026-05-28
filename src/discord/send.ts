import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import type { RawFile } from "@discordjs/rest";
import type { Message, MessageCreateOptions } from "discord.js";
import { type REST, Routes } from "discord.js";

import type { StoredAttachment } from "../chat-log.js";
import type { Config } from "../config.js";
import { parseAgentReply as parseSilentMarker } from "../silent-marker.js";
import type { DiscordChatChannel } from "./channel.js";
import { chunkDiscord } from "./chunking.js";

const NEWLINE_BURST_DELAY_MS = 500;
const DISCORD_ATTACHMENT_SEND_TIMEOUT_MS = 20_000;

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

export async function buildRawFiles(attachments: StoredAttachment[]): Promise<RawFile[]> {
	const files: RawFile[] = [];
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
	rest: REST,
	channelId: string,
	attachments: StoredAttachment[],
): Promise<string[]> {
	const files = await buildRawFiles(attachments);
	if (files.length === 0) return [];
	const data = (await rest.post(Routes.channelMessages(channelId), {
		files,
		body: {},
		signal: AbortSignal.timeout(DISCORD_ATTACHMENT_SEND_TIMEOUT_MS),
	})) as { id?: string };
	if (!data.id) throw new Error("Discord attachment send failed: no message id returned");
	return [data.id];
}

export function parseOutboundReply(text: string): { text: string; silent: boolean } {
	const parsed = parseSilentMarker(text);
	if (parsed.silent) return parsed;
	return { text: normalizeOutboundText(parsed.text), silent: false };
}

export async function sendReply(
	config: Config,
	rest: REST,
	message: Message,
	text: string,
	replyToMessageId?: string,
	attachments: StoredAttachment[] = [],
): Promise<string[]> {
	const normalizedText = normalizeOutboundText(text);
	const chunks = chunkDiscord(config, normalizedText);
	const sentIds: string[] = [];
	for (const [index, chunk] of chunks.entries()) {
		if (index > 0) await delayBetweenBurstChunks(config, message.channel);
		let sent: Message;
		if (index === 0 && config.discord.replyMode === "reply") {
			try {
				const replyTarget = replyToMessageId || message.id;
				if (!message.channel.isSendable()) {
					throw new Error(`Discord channel is not sendable: ${message.channelId}`);
				}
				const options: MessageCreateOptions = { content: chunk, reply: { messageReference: replyTarget } };
				sent = await message.channel.send(options);
				sentIds.push(sent.id);
				continue;
			} catch (error) {
				console.error("Discord reply failed; falling back to channel send", error);
			}
		}
		if (!message.channel.isSendable()) {
			throw new Error(`Discord channel is not sendable: ${message.channelId}`);
		}
		sent = await message.channel.send(chunk);
		sentIds.push(sent.id);
	}
	const attachmentIds = await sendDiscordAttachments(rest, message.channelId, attachments);
	return [...sentIds, ...attachmentIds];
}

export async function sendChannelMessage(
	config: Config,
	rest: REST,
	channel: DiscordChatChannel,
	text: string,
	attachments: StoredAttachment[] = [],
): Promise<string[]> {
	if (!channel.isSendable()) {
		throw new Error("Discord channel is not sendable");
	}
	const normalizedText = normalizeOutboundText(text);
	const chunks = chunkDiscord(config, normalizedText);
	const sentIds: string[] = [];
	for (const [index, chunk] of chunks.entries()) {
		if (index > 0) await delayBetweenBurstChunks(config, channel);
		const sent = await channel.send(chunk);
		sentIds.push(sent.id);
	}
	const attachmentIds = await sendDiscordAttachments(rest, channel.id, attachments);
	return [...sentIds, ...attachmentIds];
}

export async function sendDiscordAttachments(
	rest: REST,
	channelId: string,
	attachments: StoredAttachment[],
): Promise<string[]> {
	if (attachments.length === 0) return [];
	try {
		return await postDiscordAttachments(rest, channelId, attachments);
	} catch (error) {
		console.error("Discord attachment send failed", error);
		return [];
	}
}
