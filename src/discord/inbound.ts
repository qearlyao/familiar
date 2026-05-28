import type { Message } from "discord.js";

import type { InboundChatRecord } from "../chat-log.js";
import type { Config } from "../config.js";
import { materializeInboundAttachments } from "../inbound-attachments.js";
import type { ConversationRuntime, InboundMessageInput } from "../runtime.js";
import type { EffectiveSetting, SettingsStore } from "../settings.js";
import { isDmChannel, messageMentionsBot } from "./channel.js";

export function getDispatchMode(config: Config, message: Message): "steer" | "queue" | "collect" {
	return isDmChannel(message.channel) ? config.discord.dmMode : config.discord.channelMode;
}

export function getChannelTriggerSetting(
	config: Config,
	settings: SettingsStore,
	channelKey: string,
	isDm: boolean,
): EffectiveSetting<Config["discord"]["channelTrigger"]> {
	if (isDm) return { value: "always", source: "config" };
	return settings.getChannelTrigger(channelKey, config.discord.channelTrigger);
}

export function canSteerFromRecord(
	config: Config,
	message: Message,
	runtime: ConversationRuntime,
	record: InboundChatRecord,
	activeAgentOwner: string | undefined,
	channelTrigger: Config["discord"]["channelTrigger"],
): boolean {
	if (getDispatchMode(config, message) !== "steer") return false;
	if (!runtime.hasActiveJob() || activeAgentOwner !== runtime.channelKey) return false;
	if (isDmChannel(message.channel)) return record.authorId === config.discord.ownerId && !record.isBot;
	if (channelTrigger === "always") return true;
	return record.mentionedBot;
}

export async function toInboundInput(
	config: Config,
	message: Message,
	botUserId: string,
): Promise<InboundMessageInput> {
	const attachments = await materializeInboundAttachments(
		config,
		[...message.attachments.values()].map((attachment) => ({
			id: attachment.id,
			name: attachment.name,
			mimeType: attachment.contentType ?? undefined,
			size: attachment.size,
			url: attachment.url,
			source: "discord",
		})),
	);
	return {
		messageId: message.id,
		authorId: message.author.id,
		authorName: message.author.username,
		text: message.content || "",
		isBot: message.author.bot,
		mentionedBot: messageMentionsBot(message, botUserId),
		remoteTimestamp: new Date(message.createdTimestamp || Date.now()).toISOString(),
		checkpoint: {
			messageId: message.id,
		},
		attachments,
	};
}
