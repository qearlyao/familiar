import { once } from "node:events";

import {
	ChannelType,
	Client,
	Events,
	GatewayIntentBits,
	type Message,
	type MessageCreateOptions,
	Partials,
} from "discord.js";
import type { FamiliarAgent } from "./agent.js";
import { type ChatChannelRef, chatChannelKey, createChatLog } from "./chat-log.js";
import type { Config } from "./config.js";
import { ConversationRuntime, type InboundMessageInput } from "./runtime.js";

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

function normalizeOutboundText(text: string): string {
	return text.trim() || "(empty response)";
}

async function sendReply(message: Message, text: string, replyToMessageId?: string): Promise<string[]> {
	const normalizedText = normalizeOutboundText(text);
	const chunks = chunkDiscord(normalizedText);
	const sentIds: string[] = [];
	for (const [index, chunk] of chunks.entries()) {
		let sent: Message;
		if (index === 0) {
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
	return sentIds;
}

function getChannelRef(message: Message): ChatChannelRef {
	const scope = message.channel.type === ChannelType.DM ? "dm" : message.channel.isThread() ? "thread" : "channel";
	const channelName = "name" in message.channel ? message.channel.name : undefined;
	return {
		service: "discord",
		scope,
		channelId: message.channelId,
		channelName: typeof channelName === "string" ? channelName : undefined,
		threadId: message.channel.isThread() ? message.channel.id : undefined,
	};
}

function runtimeKeyFromMessage(message: Message): string {
	return chatChannelKey(getChannelRef(message));
}

function messageMentionsBot(message: Message, botUserId: string): boolean {
	if (message.mentions.users.has(botUserId)) return true;
	return message.content.includes(`<@${botUserId}>`) || message.content.includes(`<@!${botUserId}>`);
}

function toInboundInput(message: Message, botUserId: string): InboundMessageInput {
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
		attachments: [...message.attachments.values()].map((attachment) => ({
			id: attachment.id,
			name: attachment.name,
			mimeType: attachment.contentType ?? undefined,
			size: attachment.size,
			remoteUrl: attachment.url,
		})),
	};
}

function formatCommandResponse(
	command: "status" | "compact",
	runtime: ConversationRuntime,
	familiarAgent: FamiliarAgent,
): string {
	if (command === "status") {
		return [
			runtime.formatStatus(),
			`model: ${familiarAgent.getModelName()}`,
			`thinking: ${familiarAgent.getThinkingLevel()}`,
		].join("\n");
	}
	return "Compact is not wired for this runtime yet. I logged the command, but I won't run lossy compaction here.";
}

function isCanceledJob(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "CanceledJobError" || error.name === "AbortError" || /aborted|abort/i.test(error.message);
}

function canceledJobError(): Error {
	const error = new Error("Job was canceled before completion.");
	error.name = "CanceledJobError";
	return error;
}

export async function startDiscordDaemon(config: Config, familiarAgent: FamiliarAgent): Promise<DiscordDaemon> {
	const client = await withReadyClient(config.discord.token);
	console.log(`Discord connected as ${client.user.tag}`);
	const runtimes = new Map<string, Promise<ConversationRuntime>>();
	let activeAgentOwner: string | undefined;
	let agentWorkQueue = Promise.resolve();

	const promptForRuntime = async (runtime: ConversationRuntime, jobId: string, prompt: string): Promise<string> => {
		const run = agentWorkQueue.then(async () => {
			if (!runtime.hasActiveJob(jobId)) throw canceledJobError();
			activeAgentOwner = runtime.channelKey;
			try {
				const reply = await familiarAgent.prompt(prompt);
				if (!runtime.hasActiveJob(jobId)) throw canceledJobError();
				return reply;
			} finally {
				if (activeAgentOwner === runtime.channelKey) activeAgentOwner = undefined;
			}
		});
		agentWorkQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	const getRuntime = async (message: Message): Promise<ConversationRuntime> => {
		const channel = getChannelRef(message);
		const channelKey = chatChannelKey(channel);
		const existing = runtimes.get(channelKey);
		if (existing) return existing;
		const runtimePromise = ConversationRuntime.connect({
			channelKey,
			log: createChatLog(config, channel),
			ownerId: config.discord.ownerId,
			botUserId: client.user.id,
		}).then(async (runtime) => {
			await runtime.armAfterCurrentTail();
			return runtime;
		});
		runtimes.set(channelKey, runtimePromise);
		try {
			return await runtimePromise;
		} catch (error) {
			runtimes.delete(channelKey);
			throw error;
		}
	};

	const drainJobs = async (message: Message, runtime: ConversationRuntime): Promise<void> => {
		for (;;) {
			const dispatch = runtime.beginNextJob();
			if (!dispatch) return;
			try {
				const reply = await promptForRuntime(runtime, dispatch.job.jobId, dispatch.prompt);
				const sentText = normalizeOutboundText(reply);
				const messageIds = await sendReply(message, sentText, dispatch.triggerMessageId);
				await runtime.completeActiveJob({
					text: sentText,
					messageIds,
					replyToMessageId: dispatch.triggerMessageId,
				});
			} catch (error) {
				if (isCanceledJob(error) || !runtime.hasActiveJob(dispatch.job.jobId)) return;
				const errorText = error instanceof Error ? error.message : String(error);
				await runtime.failActiveJob(errorText);
				await runtime.appendError(errorText);
				const fallback = "I hit an error while handling that message.";
				const messageIds = await sendReply(message, fallback, dispatch.triggerMessageId);
				await runtime.noteOutbound({
					text: fallback,
					messageIds,
					replyToMessageId: dispatch.triggerMessageId,
					jobId: dispatch.job.jobId,
				});
			}
		}
	};

	const onMessageCreate = async (message: Message) => {
		if (!isAllowedMessage(config, message)) return;
		let runtime: ConversationRuntime;
		try {
			runtime = await getRuntime(message);
			const input = toInboundInput(message, client.user.id);
			const control = runtime.parseControlCommand(input);
			if (control) {
				await runtime.noteControlCommand(input, control);
				if (control.command === "stop") {
					if (runtime.hasActiveJob() && activeAgentOwner === runtime.channelKey) familiarAgent.abort();
					await runtime.resetConversation("stop requested");
					const text = "Stopped current work and cleared the chat queue.";
					const messageIds = await sendReply(message, text);
					await runtime.noteOutbound({ text, messageIds, control: control.command });
					return;
				}
				if (control.command === "new") {
					familiarAgent.reset();
					await runtime.resetConversation("new conversation requested");
					const text = "Started a fresh agent transcript for this daemon.";
					const messageIds = await sendReply(message, text);
					await runtime.noteOutbound({ text, messageIds, control: control.command });
					return;
				}
				if (control.command === "model") {
					const text = control.args
						? familiarAgent.setModel(control.args)
						: `Current model: ${familiarAgent.getModelName()}`;
					const messageIds = await sendReply(message, text);
					await runtime.noteOutbound({ text, messageIds, control: control.command });
					return;
				}
				if (control.command === "thinking") {
					const text = control.args
						? familiarAgent.setThinkingLevel(control.args)
						: `Current thinking: ${familiarAgent.getThinkingLevel()}`;
					const messageIds = await sendReply(message, text);
					await runtime.noteOutbound({ text, messageIds, control: control.command });
					return;
				}
				const text = formatCommandResponse(control.command, runtime, familiarAgent);
				const messageIds = await sendReply(message, text);
				await runtime.noteOutbound({ text, messageIds, control: control.command });
				return;
			}
			await runtime.ingestInbound(input);
			await drainJobs(message, runtime);
		} catch (error) {
			console.error("Discord message handling failed", error);
			const channelKey = runtimeKeyFromMessage(message);
			const existingRuntime = await runtimes.get(channelKey)?.catch(() => undefined);
			await existingRuntime?.appendError(error instanceof Error ? error.message : String(error));
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
			const resolvedRuntimes = await Promise.all(
				[...runtimes.values()].map((runtime) => runtime.catch(() => undefined)),
			);
			await Promise.all(resolvedRuntimes.flatMap((runtime) => (runtime ? [runtime.disconnect()] : [])));
			client.destroy();
		},
	};
}
