import type { AutocompleteInteraction, ChatInputCommandInteraction, Message, MessageResolvable } from "discord.js";
import { ChannelType } from "discord.js";

import { type ChatChannelRef, chatChannelKey } from "../chat-log.js";

export type DiscordInteractionChannel = NonNullable<
	ChatInputCommandInteraction["channel"] | AutocompleteInteraction["channel"]
>;
export type DiscordChatChannel = Message["channel"] | DiscordInteractionChannel;

export function buildChannelRef(channel: DiscordChatChannel, channelId: string): ChatChannelRef {
	const scope = channel.type === ChannelType.DM ? "dm" : channel.isThread() ? "thread" : "channel";
	const channelName = "name" in channel ? channel.name : undefined;
	return {
		service: "discord",
		scope,
		channelId,
		channelName: typeof channelName === "string" ? channelName : undefined,
		threadId: channel.isThread() ? channel.id : undefined,
	};
}

export function getChannelRef(message: Message): ChatChannelRef {
	return buildChannelRef(message.channel, message.channelId);
}

export function runtimeKeyFromMessage(message: Message): string {
	return chatChannelKey(getChannelRef(message));
}

export function isDmChannel(channel: DiscordChatChannel | null | undefined): boolean {
	return channel?.type === ChannelType.DM;
}

export async function fetchMessageAnchor(message: Message, messageId?: string): Promise<Message> {
	if (!messageId || message.id === messageId) return message;
	return message.channel.messages.fetch(messageId as MessageResolvable).catch(() => message);
}

export function messageMentionsBot(message: Message, botUserId: string): boolean {
	if (message.mentions.users.has(botUserId)) return true;
	return message.content.includes(`<@${botUserId}>`) || message.content.includes(`<@!${botUserId}>`);
}
