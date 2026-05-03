import { once } from "node:events";

import { ChannelType, Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";
import type { FamiliarAgent } from "./agent.js";
import type { Config } from "./config.js";

export interface DiscordDaemon {
	client: Client<true>;
	stop(): Promise<void>;
}

async function withReadyClient(token: string): Promise<Client<true>> {
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

function isAllowedMessage(config: Config, message: Message): boolean {
	if (message.author.bot) return false;
	if (message.author.id !== config.discord.ownerId) return false;
	if (message.channel.type === ChannelType.DM) return true;
	return config.discord.allowedChannels.includes(message.channelId);
}

function chunkDiscord(text: string): string[] {
	const limit = 2000;
	if (text.length <= limit) return [text || "(empty response)"];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= limit) {
			chunks.push(remaining);
			break;
		}
		const breakpoint = Math.max(remaining.lastIndexOf("\n", limit), remaining.lastIndexOf(" ", limit));
		const splitAt = breakpoint > 0 ? breakpoint : limit;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).trimStart();
	}
	return chunks;
}

async function sendReply(message: Message, text: string): Promise<void> {
	const chunks = chunkDiscord(text);
	for (const [index, chunk] of chunks.entries()) {
		if (index === 0) {
			try {
				await message.reply(chunk);
				continue;
			} catch (error) {
				console.error("Discord reply failed; falling back to channel send", error);
			}
		}
		if (!message.channel.isSendable()) {
			throw new Error(`Discord channel is not sendable: ${message.channelId}`);
		}
		await message.channel.send(chunk);
	}
}

export async function startDiscordDaemon(config: Config, familiarAgent: FamiliarAgent): Promise<DiscordDaemon> {
	const client = await withReadyClient(config.discord.token);
	console.log(`Discord connected as ${client.user.tag}`);

	const onMessageCreate = async (message: Message) => {
		if (!isAllowedMessage(config, message)) return;
		const timestamp = new Date(message.createdTimestamp || Date.now()).toISOString();
		const prompt = `[uid:${config.discord.ownerId} @ ${timestamp}] ${message.content || ""}`;
		try {
			const reply = await familiarAgent.prompt(prompt);
			await sendReply(message, reply);
		} catch (error) {
			console.error("Discord message handling failed", error);
			await sendReply(message, "I hit an error while handling that message.");
		}
	};

	client.on(Events.MessageCreate, onMessageCreate);
	client.on(Events.Error, (error) => console.error("Discord client error", error));
	client.on(Events.Warn, (warning) => console.warn("Discord warning", warning));
	client.ws.on("close" as any, (event: unknown) => {
		console.warn("Discord websocket closed; discord.js will reconnect when possible", event);
	});

	return {
		client,
		async stop(): Promise<void> {
			client.off(Events.MessageCreate, onMessageCreate);
			client.destroy();
		},
	};
}
