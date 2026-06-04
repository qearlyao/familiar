import { once } from "node:events";

import { ChannelType, Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";

import type { Config } from "../config/index.js";

export async function withReadyClient(token: string): Promise<Client<true>> {
	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.MessageContent,
		],
		partials: [Partials.Channel],
	});
	const readyPromise = once(client, Events.ClientReady);
	try {
		await client.login(token);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("Used disallowed intents")) {
			throw new Error(
				'Discord rejected the configured gateway intents. Enable the "Message Content Intent" in the Discord Developer Portal.',
			);
		}
		throw error;
	}
	if (!client.isReady()) {
		await Promise.race([
			readyPromise,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("Discord client failed to become ready")), 10000),
			),
		]);
	}
	if (!client.isReady()) throw new Error("Discord client failed to become ready");
	return client as Client<true>;
}

export function isAllowedMessage(config: Config, message: Message, botUserId: string): boolean {
	if (message.author.id === botUserId) return false;
	if (message.author.bot && !config.discord.allowBotMessages) return false;
	if (message.channel.type === ChannelType.DM && message.author.id !== config.discord.ownerId) return false;
	if (message.channel.type === ChannelType.DM) return true;
	return config.discord.allowedChannels.includes(message.channelId);
}
