import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ApplicationCommandData,
	type ApplicationCommandOptionChoiceData,
	ApplicationCommandOptionType,
	ApplicationCommandType,
	ApplicationIntegrationType,
	type AutocompleteInteraction,
	ChannelType,
	type ChatInputCommandInteraction,
	Client,
	Events,
	GatewayIntentBits,
	type Interaction,
	InteractionContextType,
	type Message,
	type MessageCreateOptions,
	MessageFlags,
	type MessageResolvable,
	Partials,
} from "discord.js";
import type { FamiliarAgent, FamiliarAgentReply, FamiliarPromptOptions } from "./agent.js";
import {
	type AgentEventSummary,
	createAgentEventRecorder,
	storedAgentEventFromAgentEvent,
	thinkingDurationMs,
	updateAgentEventSummary,
} from "./agent-events.js";
import type { InboundChatRecord, StoredAttachment } from "./chat-log.js";
import { type ChatChannelRef, chatChannelKey, createChatLog } from "./chat-log.js";
import type { Config } from "./config.js";
import type { RestartHandler } from "./control.js";
import { materializeInboundAttachments, promptImagesFromAttachments } from "./inbound-attachments.js";
import type { MemoryService } from "./memory/service.js";
import { ConversationRuntime, type InboundMessageInput } from "./runtime.js";
import {
	appendSchedulerLog,
	buildCronInjectionText,
	buildHeartbeatInjectionText,
	type CronJobConfig,
	dueCronSlot,
	isHeartbeatDue,
	loadSchedulerState,
	type SchedulerState,
	saveSchedulerState,
} from "./scheduler.js";
import type { EffectiveSetting, SettingsStore } from "./settings.js";
import { parseAgentReply as parseSilentMarker } from "./silent-marker.js";

const FAMILIAR_COMMAND_NAME = "familiar";
const THINKING_CHOICES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const CHANNEL_TRIGGER_CHOICES = ["mention", "always"] as const;
const EPHEMERAL_REPLY = MessageFlags.Ephemeral;
const HEARTBEAT_SKIPPED = Symbol("heartbeat-skipped");
const CRON_SKIPPED = Symbol("cron-skipped");

export interface DiscordDaemon {
	client: Client<true>;
	getWebSessions(): Promise<DiscordWebSession[]>;
	getRuntimeForWebChannel(channelKey?: string): Promise<ConversationRuntime>;
	runPromptForWeb(
		runtime: ConversationRuntime,
		jobId: string,
		prompt: string,
		attachments?: StoredAttachment[],
		onEvent?: (event: AgentEvent) => void | Promise<void>,
		onTurnEnd?: () => void | Promise<void>,
	): Promise<FamiliarAgentReply>;
	abortWebRuntime(runtime: ConversationRuntime): void;
	getActiveRuntimeKey(): string | undefined;
	rearmHeartbeat(): void;
	stop(): Promise<void>;
}

export interface DiscordWebSession {
	key: string;
	label: string;
	channel: ChatChannelRef;
	isDefault?: boolean;
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

function getFamiliarApplicationCommand(): ApplicationCommandData {
	const modelOption = {
		name: "model",
		description: "Provider/model id",
		type: ApplicationCommandOptionType.String,
		required: false,
		autocomplete: true,
	} as const;
	return {
		name: FAMILIAR_COMMAND_NAME,
		description: "Control Familiar",
		type: ApplicationCommandType.ChatInput,
		contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
		integrationTypes: [ApplicationIntegrationType.GuildInstall],
		options: [
			{
				name: "status",
				description: "Show Familiar status for this channel",
				type: ApplicationCommandOptionType.Subcommand,
			},
			{
				name: "stop",
				description: "Stop current work and clear the queue",
				type: ApplicationCommandOptionType.Subcommand,
			},
			{
				name: "new",
				description: "Start a fresh agent transcript for this channel",
				type: ApplicationCommandOptionType.Subcommand,
			},
			{
				name: "reload",
				description: "Reload persona prompt files and live agent settings",
				type: ApplicationCommandOptionType.Subcommand,
			},
			{
				name: "restart",
				description: "Restart Familiar if this runtime has a restart handler",
				type: ApplicationCommandOptionType.Subcommand,
			},
			{
				name: "compact",
				description: "Show compaction status",
				type: ApplicationCommandOptionType.Subcommand,
			},
			{
				name: "model",
				description: "Show or set the model for this channel",
				type: ApplicationCommandOptionType.Subcommand,
				options: [modelOption],
			},
			{
				name: "thinking",
				description: "Show or set thinking level for this channel",
				type: ApplicationCommandOptionType.Subcommand,
				options: [
					{
						name: "level",
						description: "Thinking level",
						type: ApplicationCommandOptionType.String,
						required: false,
						choices: THINKING_CHOICES.map((level) => ({ name: level, value: level })),
					},
				],
			},
			{
				name: "channel-trigger",
				description: "Show or set when Familiar responds in this channel",
				type: ApplicationCommandOptionType.Subcommand,
				options: [
					{
						name: "trigger",
						description: "Channel trigger policy",
						type: ApplicationCommandOptionType.String,
						required: false,
						choices: CHANNEL_TRIGGER_CHOICES.map((trigger) => ({ name: trigger, value: trigger })),
					},
				],
			},
		],
	};
}

async function registerFamiliarApplicationCommand(client: Client<true>): Promise<void> {
	const command = getFamiliarApplicationCommand();
	const commands = await client.application.commands.fetch({ force: true });
	const existing = commands.find(
		(candidate) => candidate.name === FAMILIAR_COMMAND_NAME && candidate.type === ApplicationCommandType.ChatInput,
	);
	if (existing) {
		if (!existing.equals(command)) {
			await client.application.commands.edit(existing.id, command);
			console.log(`Updated Discord /${FAMILIAR_COMMAND_NAME} command`);
		}
		return;
	}
	await client.application.commands.create(command);
	console.log(`Registered Discord /${FAMILIAR_COMMAND_NAME} command`);
}

function isAllowedMessage(config: Config, message: Message, botUserId: string): boolean {
	if (message.author.id === botUserId) return false;
	if (message.author.bot && !config.discord.allowBotMessages) return false;
	if (message.channel.type === ChannelType.DM && message.author.id !== config.discord.ownerId) return false;
	if (message.channel.type === ChannelType.DM) return true;
	return config.discord.allowedChannels.includes(message.channelId);
}

function isAllowedInteractionChannel(
	config: Config,
	interaction: ChatInputCommandInteraction | AutocompleteInteraction,
): boolean {
	if (interaction.user.id !== config.discord.ownerId) return false;
	const channel = interaction.channel;
	if (!channel) return false;
	if (channel.type === ChannelType.DM) return true;
	return interaction.channelId ? config.discord.allowedChannels.includes(interaction.channelId) : false;
}

const NEWLINE_BURST_DELAY_MS = 500;

function chunkDiscordSimple(text: string, limit = 2000): string[] {
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

function splitLongBlock(block: string, limit: number): string[] {
	if (block.length <= limit) return [block];
	const pieces: string[] = [];
	let lineCurrent = "";
	for (const line of block.split("\n")) {
		const candidate = lineCurrent ? `${lineCurrent}\n${line}` : line;
		if (candidate.length <= limit) {
			lineCurrent = candidate;
			continue;
		}
		if (lineCurrent) {
			pieces.push(lineCurrent);
			lineCurrent = "";
		}
		if (line.length <= limit) {
			lineCurrent = line;
			continue;
		}
		let remaining = line;
		while (remaining.length > limit) {
			let splitAt = remaining.lastIndexOf(" ", limit);
			if (splitAt < Math.floor(limit * 0.6)) splitAt = limit;
			pieces.push(remaining.slice(0, splitAt));
			remaining = remaining.slice(splitAt).trimStart();
		}
		lineCurrent = remaining;
	}
	if (lineCurrent) pieces.push(lineCurrent);
	return pieces;
}

function chunkDiscordParagraph(text: string, limit = 2000): string[] {
	if (text.length <= limit) return [text || "(empty response)"];
	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	const pushCurrent = () => {
		if (current.trim()) chunks.push(current);
		current = "";
	};

	for (const paragraph of paragraphs) {
		if (!paragraph) continue;
		for (const part of splitLongBlock(paragraph, limit)) {
			const candidate = current ? `${current}\n\n${part}` : part;
			if (candidate.length <= limit) {
				current = candidate;
			} else {
				pushCurrent();
				current = part;
			}
		}
	}
	pushCurrent();
	return chunks.length > 0 ? chunks : [normalized.slice(0, limit)];
}

function splitPreservingCodeFences(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n");
	const segments: string[] = [];
	const fence = /```/g;
	let cursor = 0;
	let inCode = false;
	let buffer = "";

	const flushParagraphs = (slab: string) => {
		const parts = slab.split(/\n\n+/);
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (i === 0) {
				buffer += part;
			} else {
				if (buffer.trim()) segments.push(buffer);
				buffer = part;
			}
		}
	};

	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
	while ((match = fence.exec(normalized)) !== null) {
		const slab = normalized.slice(cursor, match.index);
		if (inCode) {
			buffer += slab + match[0];
			inCode = false;
		} else {
			flushParagraphs(slab);
			buffer += match[0];
			inCode = true;
		}
		cursor = match.index + match[0].length;
	}
	const tail = normalized.slice(cursor);
	if (inCode) {
		buffer += tail;
	} else {
		flushParagraphs(tail);
	}
	if (buffer.trim()) segments.push(buffer);

	return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

function chunkDiscordNewline(text: string, limit = 2000): string[] {
	const segments = splitPreservingCodeFences(text);
	if (segments.length === 0) return [];
	const chunks: string[] = [];
	for (const segment of segments) {
		if (segment.length <= limit) {
			chunks.push(segment);
			continue;
		}
		for (const part of splitLongBlock(segment, limit)) {
			if (part.trim()) chunks.push(part);
		}
	}
	return chunks;
}

function chunkDiscord(config: Config, text: string): string[] {
	if (config.discord.chunkMode === "simple") return chunkDiscordSimple(text);
	if (config.discord.chunkMode === "newline") return chunkDiscordNewline(text);
	return chunkDiscordParagraph(text);
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

function normalizeOutboundText(text: string): string {
	return text.trim() || "(empty response)";
}

async function discordAttachmentPayload(
	attachment: StoredAttachment,
): Promise<{ attachment: Buffer; name: string } | undefined> {
	if (!attachment.localPath) return undefined;
	return {
		attachment: await readFile(attachment.localPath),
		name: attachment.name,
	};
}

async function discordAttachmentPayloads(
	attachments: StoredAttachment[],
): Promise<{ attachment: Buffer; name: string }[]> {
	const payloads: { attachment: Buffer; name: string }[] = [];
	for (const attachment of attachments) {
		const payload = await discordAttachmentPayload(attachment);
		if (payload) payloads.push(payload);
	}
	return payloads;
}

export const __test = {
	discordAttachmentPayloads,
};

function parseAgentReply(text: string): { text: string; silent: boolean } {
	const parsed = parseSilentMarker(text);
	if (parsed.silent) return parsed;
	return { text: normalizeOutboundText(parsed.text), silent: false };
}

async function sendReply(
	config: Config,
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
		const files = index === 0 ? await discordAttachmentPayloads(attachments) : [];
		let sent: Message;
		if (index === 0 && config.discord.replyMode === "reply") {
			try {
				const replyTarget = replyToMessageId || message.id;
				if (!message.channel.isSendable()) {
					throw new Error(`Discord channel is not sendable: ${message.channelId}`);
				}
				const options: MessageCreateOptions = { content: chunk, reply: { messageReference: replyTarget }, files };
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
		sent = await message.channel.send(files.length > 0 ? { content: chunk, files } : chunk);
		sentIds.push(sent.id);
	}
	return sentIds;
}

async function sendChannelMessage(
	config: Config,
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
		const files = index === 0 ? await discordAttachmentPayloads(attachments) : [];
		const sent = await channel.send(files.length > 0 ? { content: chunk, files } : chunk);
		sentIds.push(sent.id);
	}
	return sentIds;
}

type DiscordInteractionChannel = NonNullable<
	ChatInputCommandInteraction["channel"] | AutocompleteInteraction["channel"]
>;
type DiscordChatChannel = Message["channel"] | DiscordInteractionChannel;

function buildChannelRef(channel: DiscordChatChannel, channelId: string): ChatChannelRef {
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

function getChannelRef(message: Message): ChatChannelRef {
	return buildChannelRef(message.channel, message.channelId);
}

function runtimeKeyFromMessage(message: Message): string {
	return chatChannelKey(getChannelRef(message));
}

function isDmChannel(channel: DiscordChatChannel | null | undefined): boolean {
	return channel?.type === ChannelType.DM;
}

function getDispatchMode(config: Config, message: Message): "steer" | "queue" | "collect" {
	return isDmChannel(message.channel) ? config.discord.dmMode : config.discord.channelMode;
}

function getChannelTriggerSetting(
	config: Config,
	settings: SettingsStore,
	channelKey: string,
	isDm: boolean,
): EffectiveSetting<Config["discord"]["channelTrigger"]> {
	if (isDm) return { value: "always", source: "config" };
	return settings.getChannelTrigger(channelKey, config.discord.channelTrigger);
}

function canSteerFromRecord(
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

function formatSetting<T>(setting: EffectiveSetting<T>): string {
	return `${setting.value} (${setting.source})`;
}

function messageMentionsBot(message: Message, botUserId: string): boolean {
	if (message.mentions.users.has(botUserId)) return true;
	return message.content.includes(`<@${botUserId}>`) || message.content.includes(`<@!${botUserId}>`);
}

async function toInboundInput(config: Config, message: Message, botUserId: string): Promise<InboundMessageInput> {
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

async function fetchMessageAnchor(message: Message, messageId?: string): Promise<Message> {
	if (!messageId || message.id === messageId) return message;
	return message.channel.messages.fetch(messageId as MessageResolvable).catch(() => message);
}

function commandTextFromInteraction(interaction: ChatInputCommandInteraction): string {
	const subcommand = interaction.options.getSubcommand(true);
	if (subcommand === "model") {
		const model = interaction.options.getString("model");
		return model ? `/model ${model}` : "/model";
	}
	if (subcommand === "thinking") {
		const level = interaction.options.getString("level");
		return level ? `/thinking ${level}` : "/thinking";
	}
	if (subcommand === "channel-trigger") {
		const trigger = interaction.options.getString("trigger");
		return trigger ? `/channel-trigger ${trigger}` : "/channel-trigger";
	}
	return `/${subcommand}`;
}

function inboundInputFromInteraction(interaction: ChatInputCommandInteraction): InboundMessageInput {
	return {
		messageId: interaction.id,
		authorId: interaction.user.id,
		authorName: interaction.user.username,
		text: commandTextFromInteraction(interaction),
		isBot: false,
		mentionedBot: true,
		remoteTimestamp: new Date(interaction.createdTimestamp || Date.now()).toISOString(),
	};
}

async function replyEphemeral(interaction: ChatInputCommandInteraction, text: string): Promise<string[]> {
	const content = normalizeOutboundText(text);
	if (interaction.deferred || interaction.replied) {
		await interaction.editReply({ content });
	} else {
		await interaction.reply({ content, flags: EPHEMERAL_REPLY });
	}
	const reply = await interaction.fetchReply().catch(() => undefined);
	return reply?.id ? [reply.id] : [];
}

async function replyInteractionError(interaction: ChatInputCommandInteraction, error: unknown): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	console.error("Discord interaction handling failed", error);
	await replyEphemeral(interaction, `I hit an error while handling that command.\n${message}`);
}

function formatCommandResponse(
	command: "status" | "compact",
	runtime: ConversationRuntime,
	familiarAgent: FamiliarAgent,
	channelTrigger: EffectiveSetting<Config["discord"]["channelTrigger"]>,
): string {
	if (command === "status") {
		return [
			runtime.formatStatus(),
			`model: ${formatSetting(familiarAgent.getModel(runtime.channelKey))}`,
			`thinking: ${formatSetting(familiarAgent.getThinkingLevel(runtime.channelKey))}`,
			`channel_trigger: ${formatSetting(channelTrigger)}`,
		].join("\n");
	}
	return "Compact is not wired for this runtime yet. I logged the command, but I won't run lossy compaction here.";
}

async function applyControlCommand(options: {
	control: NonNullable<ReturnType<ConversationRuntime["parseControlCommand"]>>;
	runtime: ConversationRuntime;
	familiarAgent: FamiliarAgent;
	settings: SettingsStore;
	channelTrigger: EffectiveSetting<Config["discord"]["channelTrigger"]>;
	isDm: boolean;
	activeAgentOwner: string | undefined;
	restart?: RestartHandler;
}): Promise<string> {
	const { control, runtime, familiarAgent, settings, channelTrigger, isDm, activeAgentOwner, restart } = options;
	if (control.command === "stop") {
		if (runtime.hasActiveJob() && activeAgentOwner === runtime.channelKey) familiarAgent.abort(runtime.channelKey);
		await runtime.resetConversation("stop requested");
		return "Stopped current work and cleared the chat queue.";
	}
	if (control.command === "new") {
		await familiarAgent.reset(runtime.channelKey);
		await runtime.resetConversation("new conversation requested");
		return "Started a fresh agent transcript for this channel.";
	}
	if (control.command === "reload") {
		return familiarAgent.reload();
	}
	if (control.command === "restart") {
		return restart
			? await restart()
			: "Restart requested, but no restart handler is configured. Please restart the Familiar process manually.";
	}
	if (control.command === "model") {
		return control.args
			? await familiarAgent.setModel(runtime.channelKey, control.args)
			: `Current model: ${formatSetting(familiarAgent.getModel(runtime.channelKey))}`;
	}
	if (control.command === "thinking") {
		return control.args
			? await familiarAgent.setThinkingLevel(runtime.channelKey, control.args)
			: `Current thinking: ${formatSetting(familiarAgent.getThinkingLevel(runtime.channelKey))}`;
	}
	if (control.command === "channel-trigger") {
		if (isDm) {
			return "DM channel trigger is always.";
		}
		const triggerInput = control.args.trim().toLowerCase();
		if (triggerInput && triggerInput !== "mention" && triggerInput !== "always") {
			throw new Error("Usage: /channel-trigger mention|always");
		}
		const trigger = triggerInput === "mention" || triggerInput === "always" ? triggerInput : undefined;
		if (trigger) {
			await settings.setChannelTrigger(runtime.channelKey, trigger);
			return `Channel trigger set to ${trigger} for this channel`;
		}
		return `Current channel trigger: ${formatSetting(channelTrigger)}`;
	}
	return formatCommandResponse(control.command, runtime, familiarAgent, channelTrigger);
}

function getAutocompleteChoices(
	config: Config,
	interaction: AutocompleteInteraction,
): ApplicationCommandOptionChoiceData[] {
	if (interaction.commandName !== FAMILIAR_COMMAND_NAME) return [];
	const subcommand = interaction.options.getSubcommand(false);
	const focused = interaction.options.getFocused(true);
	const value = String(focused.value ?? "").toLowerCase();
	if (subcommand !== "model" || focused.name !== "model") return [];
	const candidates = config.models.allow.length > 0 ? config.models.allow : [config.agent.model];
	return [...new Set(candidates)]
		.filter((model) => !value || model.toLowerCase().includes(value))
		.slice(0, 25)
		.map((model) => ({ name: model, value: model }));
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

function webMessageId(): string {
	return `msg_${randomUUID()}`;
}

function scheduledUserMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function heartbeatStillDue(
	config: Config,
	now: number,
	lastUserInteractionAt: number,
	lastHeartbeatAt: string | undefined,
): boolean {
	return isHeartbeatDue({
		now,
		lastUserInteractionAt,
		lastHeartbeatAt,
		idleThresholdMs: config.heartbeat.idleThresholdMs,
		intervalMs: config.heartbeat.intervalMs,
	});
}

function startTypingIndicator(message: Message): () => void {
	const sendTyping = () => {
		if (!message.channel.isSendable()) return;
		void message.channel.sendTyping().catch(() => undefined);
	};
	sendTyping();
	const timer = setInterval(sendTyping, 8000);
	return () => {
		clearInterval(timer);
	};
}

export async function startDiscordDaemon(
	config: Config,
	familiarAgent: FamiliarAgent,
	settings: SettingsStore,
	memoryService?: MemoryService,
	options: { restart?: RestartHandler } = {},
): Promise<DiscordDaemon> {
	const client = await withReadyClient(config.discord.token);
	console.log(`Discord connected as ${client.user.tag}`);
	const runtimes = new Map<string, Promise<ConversationRuntime>>();
	const collectTimers = new Map<string, NodeJS.Timeout>();
	let activeAgentOwner: string | undefined;
	let agentWorkQueue = Promise.resolve();
	let heartbeatTimer: NodeJS.Timeout | undefined;
	let cronTimer: NodeJS.Timeout | undefined;
	let heartbeatQueued = false;
	let cronRunning = false;
	let schedulerState: SchedulerState = { cron: {} };

	const promptForRuntime = async (
		runtime: ConversationRuntime,
		jobId: string,
		prompt: string,
		attachments: StoredAttachment[] = [],
		onEvent?: (event: AgentEvent) => void | Promise<void>,
		onTurnEnd?: () => void | Promise<void>,
	): Promise<FamiliarAgentReply> => {
		const run = agentWorkQueue.then(async () => {
			if (!runtime.hasActiveJob(jobId)) throw canceledJobError();
			activeAgentOwner = runtime.channelKey;
			try {
				const promptImages = await promptImagesFromAttachments(attachments);
				const input = [prompt, promptImages.promptSuffix].filter(Boolean).join("\n");
				const reply = await familiarAgent.prompt(runtime.channelKey, input, promptImages.images, onEvent, {
					referenceAttachments: attachments,
					onTurnEnd,
				});
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

	const promptScheduledMessage = async (
		runtime: ConversationRuntime,
		buildMessage: () =>
			| AgentMessage
			| typeof HEARTBEAT_SKIPPED
			| typeof CRON_SKIPPED
			| Promise<AgentMessage | typeof HEARTBEAT_SKIPPED | typeof CRON_SKIPPED>,
		onEvent?: (event: AgentEvent) => void | Promise<void>,
		options?: FamiliarPromptOptions,
	): Promise<FamiliarAgentReply | typeof HEARTBEAT_SKIPPED | typeof CRON_SKIPPED> => {
		const run = agentWorkQueue.then(async () => {
			const message = await buildMessage();
			if (message === HEARTBEAT_SKIPPED || message === CRON_SKIPPED) return message;
			activeAgentOwner = runtime.channelKey;
			try {
				return await familiarAgent.promptMessage(runtime.channelKey, message, onEvent, options);
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

	const getRuntimeForChannel = async (channel: ChatChannelRef): Promise<ConversationRuntime> => {
		const channelKey = chatChannelKey(channel);
		const existing = runtimes.get(channelKey);
		if (existing) return existing;
		const runtimePromise = ConversationRuntime.connect({
			channelKey,
			log: createChatLog(config, channel),
			ownerId: config.discord.ownerId,
			botUserId: client.user.id,
		}).then(async (runtime) => {
			memoryService?.subscribeRuntime(runtime, runtime.channelKey);
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

	const getRuntime = async (message: Message): Promise<ConversationRuntime> => {
		return getRuntimeForChannel(getChannelRef(message));
	};

	const getInteractionRuntime = async (
		interaction: ChatInputCommandInteraction | AutocompleteInteraction,
	): Promise<ConversationRuntime> => {
		const channel = interaction.channel;
		if (!channel || !interaction.channelId) throw new Error("Discord interaction has no channel");
		return getRuntimeForChannel(buildChannelRef(channel, interaction.channelId));
	};

	const getWebSessions = async (): Promise<DiscordWebSession[]> => {
		const sessions: DiscordWebSession[] = [];
		const dmChannel = await client.users.createDM(config.discord.ownerId);
		const dmRef = buildChannelRef(dmChannel, dmChannel.id);
		sessions.push({
			key: chatChannelKey(dmRef),
			label: "Main Chat",
			channel: dmRef,
			isDefault: true,
		});
		for (const channelId of config.discord.allowedChannels) {
			const channel = await client.channels.fetch(channelId).catch(() => undefined);
			if (!channel) continue;
			const ref = buildChannelRef(channel as DiscordChatChannel, channelId);
			sessions.push({
				key: chatChannelKey(ref),
				label: ref.channelName || `Discord ${ref.scope}`,
				channel: ref,
			});
		}
		return sessions;
	};

	const getOwnerDmSession = async (): Promise<{ runtime: ConversationRuntime; channel: DiscordChatChannel }> => {
		const dmChannel = await client.users.createDM(config.discord.ownerId);
		const runtime = await getRuntimeForChannel(buildChannelRef(dmChannel, dmChannel.id));
		return { runtime, channel: dmChannel as DiscordChatChannel };
	};

	const saveScheduler = async (): Promise<void> => {
		await saveSchedulerState(config.workspace.dataDir, schedulerState);
	};

	const initializeHeartbeatState = async (runtime: ConversationRuntime): Promise<void> => {
		if (!config.heartbeat.enabled || schedulerState.heartbeat) return;
		const now = Date.now();
		const lastUserInteractionAt = runtime.getLastUserInteractionAt();
		if (now - lastUserInteractionAt < config.heartbeat.idleThresholdMs) return;
		// Treat a cold start on an already-idle transcript as "we just fired at boot":
		// the standard cadence/first-fire branches in isHeartbeatDue then handle user-reply
		// vs. no-reply correctly without a separate suppression concept.
		schedulerState.heartbeat = { lastFiredAt: new Date(now).toISOString() };
		await saveScheduler();
	};

	const getRuntimeForWebChannel = async (channelKey?: string): Promise<ConversationRuntime> => {
		const sessions = await getWebSessions();
		const session = channelKey ? sessions.find((candidate) => candidate.key === channelKey) : sessions[0];
		if (!session)
			throw new Error(channelKey ? `Unknown web session: ${channelKey}` : "No Discord sessions available");
		return getRuntimeForChannel(session.channel);
	};

	const drainJobs = async (message: Message, runtime: ConversationRuntime): Promise<void> => {
		for (;;) {
			const dispatch = runtime.beginNextJob();
			if (!dispatch) return;
			const stopTyping = startTypingIndicator(message);
			try {
				const assistantMessageId = webMessageId();
				const summary: AgentEventSummary = { thinking: "" };
				const recorder = createAgentEventRecorder((storedEvent) =>
					runtime.noteAgentEvent(dispatch.job.jobId, assistantMessageId, storedEvent, { notify: false }),
				);
				let reply: Awaited<ReturnType<typeof promptForRuntime>>;
				try {
					reply = await promptForRuntime(
						runtime,
						dispatch.job.jobId,
						dispatch.prompt,
						dispatch.attachments,
						async (event) => {
							updateAgentEventSummary(summary, event);
							const storedEvent = storedAgentEventFromAgentEvent(event);
							if (storedEvent) {
								runtime.publishAgentEvent(dispatch.job.jobId, assistantMessageId, storedEvent);
								await recorder.record(storedEvent);
							}
						},
					);
				} finally {
					await recorder.flush();
				}
				const parsedReply = parseAgentReply(reply.text);
				const messageIds = parsedReply.silent
					? []
					: await sendReply(
							config,
							await fetchMessageAnchor(message, dispatch.triggerMessageId),
							parsedReply.text,
							dispatch.triggerMessageId,
							reply.attachments,
						);
				await runtime.completeActiveJob({
					text: parsedReply.text,
					messageIds,
					webMessageId: assistantMessageId,
					attachments: reply.attachments,
					thinking: summary.thinking,
					thinkingMs: thinkingDurationMs(summary),
					silent: parsedReply.silent,
					replyToMessageId: dispatch.triggerMessageId,
				});
			} catch (error) {
				if (isCanceledJob(error) || !runtime.hasActiveJob(dispatch.job.jobId)) return;
				const errorText = error instanceof Error ? error.message : String(error);
				await runtime.failActiveJob(errorText);
				await runtime.appendError(errorText);
				const fallback = "I hit an error while handling that message.";
				const replyAnchor = await fetchMessageAnchor(message, dispatch.triggerMessageId);
				const messageIds = await sendReply(config, replyAnchor, fallback, dispatch.triggerMessageId);
				await runtime.noteOutbound({
					text: fallback,
					messageIds,
					replyToMessageId: dispatch.triggerMessageId,
					jobId: dispatch.job.jobId,
				});
			} finally {
				stopTyping();
			}
		}
	};

	const runHeartbeat = async (): Promise<void> => {
		if (!config.heartbeat.enabled) return;
		if (activeAgentOwner) return;
		if (heartbeatQueued) return;
		heartbeatQueued = true;
		let runtime: ConversationRuntime | undefined;
		try {
			const session = await getOwnerDmSession();
			runtime = session.runtime;
			const heartbeatRuntime = session.runtime;
			const channel = session.channel;
			const now = Date.now();
			if (heartbeatRuntime.hasLiveWork()) return;
			const lastUserInteractionAt = heartbeatRuntime.getLastUserInteractionAt();
			if (!heartbeatStillDue(config, now, lastUserInteractionAt, schedulerState.heartbeat?.lastFiredAt)) {
				return;
			}

			const assistantMessageId = webMessageId();
			const summary: AgentEventSummary = { thinking: "" };
			const recorder = createAgentEventRecorder((storedEvent) =>
				heartbeatRuntime.noteAgentEvent("heartbeat", assistantMessageId, storedEvent, { notify: false }),
			);
			let reply: FamiliarAgentReply | typeof HEARTBEAT_SKIPPED | typeof CRON_SKIPPED;
			try {
				reply = await promptScheduledMessage(
					heartbeatRuntime,
					async () => {
						const queuedNow = Date.now();
						const latestUserInteractionAt = heartbeatRuntime.getLastUserInteractionAt();
						if (heartbeatRuntime.hasLiveWork()) return HEARTBEAT_SKIPPED;
						if (
							!heartbeatStillDue(
								config,
								queuedNow,
								latestUserInteractionAt,
								schedulerState.heartbeat?.lastFiredAt,
							)
						) {
							return HEARTBEAT_SKIPPED;
						}
						schedulerState.heartbeat = { lastFiredAt: new Date(queuedNow).toISOString() };
						await saveScheduler();
						const text = buildHeartbeatInjectionText({ now: queuedNow, idleSince: latestUserInteractionAt });
						await heartbeatRuntime.noteHeartbeat(
							`started after ${Math.floor((queuedNow - latestUserInteractionAt) / 60_000)} idle minute(s)`,
						);
						return scheduledUserMessage(text, queuedNow);
					},
					async (event) => {
						updateAgentEventSummary(summary, event);
						const storedEvent = storedAgentEventFromAgentEvent(event);
						if (storedEvent) {
							heartbeatRuntime.publishAgentEvent("heartbeat", assistantMessageId, storedEvent);
							await recorder.record(storedEvent);
						}
					},
					{ skipAmbient: true },
				);
			} finally {
				await recorder.flush();
			}
			if (reply === HEARTBEAT_SKIPPED || reply === CRON_SKIPPED) return;
			const parsedReply = parseAgentReply(reply.text);
			const messageIds = parsedReply.silent
				? []
				: await sendChannelMessage(config, channel, parsedReply.text, reply.attachments);
			await heartbeatRuntime.noteOutbound({
				text: parsedReply.text,
				messageIds,
				webMessageId: assistantMessageId,
				attachments: reply.attachments,
				thinking: summary.thinking,
				thinkingMs: thinkingDurationMs(summary),
				silent: parsedReply.silent,
				jobId: "heartbeat",
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await runtime?.noteHeartbeatFailure(message);
			await runtime?.appendError(`Heartbeat failed: ${message}`);
			console.error("Heartbeat failed", error);
		} finally {
			heartbeatQueued = false;
		}
	};

	const markCronSlotStarted = async (job: CronJobConfig, slot: string): Promise<void> => {
		schedulerState.cron[job.id] = {
			lastFiredSlot: slot,
			lastFiredAt: new Date().toISOString(),
			...(schedulerState.cron[job.id]?.completed ? { completed: true } : {}),
		};
		await saveScheduler();
	};

	const completeCronSlot = async (job: CronJobConfig, slot: string): Promise<void> => {
		schedulerState.cron[job.id] = {
			...schedulerState.cron[job.id],
			lastFiredSlot: slot,
			lastFiredAt: schedulerState.cron[job.id]?.lastFiredAt ?? new Date().toISOString(),
			...(job.frequency === "once" ? { completed: true } : {}),
		};
		await saveScheduler();
	};

	const runCronJob = async (
		job: CronJobConfig,
		slot: string,
		runtime: ConversationRuntime,
		channel: DiscordChatChannel,
	): Promise<void> => {
		await appendSchedulerLog(config.workspace.dataDir, {
			type: "cron_due",
			jobId: job.id,
			slot,
			deliveryMode: job.deliveryMode,
		});
		if (job.deliveryMode === "follow_up" && activeAgentOwner === runtime.channelKey) {
			const now = Date.now();
			const text = buildCronInjectionText({ job, slot, now });
			await appendSchedulerLog(config.workspace.dataDir, {
				type: "cron_started",
				jobId: job.id,
				slot,
				deliveryMode: job.deliveryMode,
			});
			await markCronSlotStarted(job, slot);
			await familiarAgent.followUpMessage(runtime.channelKey, scheduledUserMessage(text, now), {
				skipAmbient: true,
			});
			await completeCronSlot(job, slot);
			await appendSchedulerLog(config.workspace.dataDir, {
				type: "cron_completed",
				jobId: job.id,
				slot,
				deliveryMode: job.deliveryMode,
				detail: "queued as follow-up",
			});
			return;
		}

		const assistantMessageId = webMessageId();
		const summary: AgentEventSummary = { thinking: "" };
		const recorder = createAgentEventRecorder((storedEvent) =>
			runtime.noteAgentEvent(`cron:${job.id}`, assistantMessageId, storedEvent, { notify: false }),
		);
		let reply: FamiliarAgentReply | typeof HEARTBEAT_SKIPPED | typeof CRON_SKIPPED;
		try {
			reply = await promptScheduledMessage(
				runtime,
				async () => {
					const jobState = schedulerState.cron[job.id];
					if (jobState?.completed || jobState?.lastFiredSlot === slot) return CRON_SKIPPED;
					const now = Date.now();
					await appendSchedulerLog(config.workspace.dataDir, {
						type: "cron_started",
						jobId: job.id,
						slot,
						deliveryMode: job.deliveryMode,
					});
					await markCronSlotStarted(job, slot);
					return scheduledUserMessage(buildCronInjectionText({ job, slot, now }), now);
				},
				async (event) => {
					updateAgentEventSummary(summary, event);
					const storedEvent = storedAgentEventFromAgentEvent(event);
					if (storedEvent) {
						runtime.publishAgentEvent(`cron:${job.id}`, assistantMessageId, storedEvent);
						await recorder.record(storedEvent);
					}
				},
				{ skipAmbient: true },
			);
		} finally {
			await recorder.flush();
		}
		if (reply === HEARTBEAT_SKIPPED || reply === CRON_SKIPPED) {
			await appendSchedulerLog(config.workspace.dataDir, {
				type: "cron_skipped",
				jobId: job.id,
				slot,
				deliveryMode: job.deliveryMode,
				detail: "already completed before prompt",
			});
			return;
		}
		const parsedReply = parseAgentReply(reply.text);
		const messageIds = parsedReply.silent
			? []
			: await sendChannelMessage(config, channel, parsedReply.text, reply.attachments);
		await runtime.noteOutbound({
			text: parsedReply.text,
			messageIds,
			webMessageId: assistantMessageId,
			attachments: reply.attachments,
			thinking: summary.thinking,
			thinkingMs: thinkingDurationMs(summary),
			silent: parsedReply.silent,
			jobId: `cron:${job.id}`,
		});
		await completeCronSlot(job, slot);
		await appendSchedulerLog(config.workspace.dataDir, {
			type: "cron_completed",
			jobId: job.id,
			slot,
			deliveryMode: job.deliveryMode,
		});
	};

	const tickCron = async (): Promise<void> => {
		if (!config.cron.enabled || cronRunning) return;
		cronRunning = true;
		try {
			const session = await getOwnerDmSession();
			for (const job of config.cron.jobs) {
				const slot = dueCronSlot(job, schedulerState.cron[job.id], Date.now());
				if (!slot) continue;
				try {
					await runCronJob(job, slot, session.runtime, session.channel);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await appendSchedulerLog(config.workspace.dataDir, {
						type: "cron_failed",
						jobId: job.id,
						slot,
						deliveryMode: job.deliveryMode,
						detail: message,
					});
					await session.runtime.appendError(`Cron job ${job.id} failed: ${message}`);
					console.error(`Cron job ${job.id} failed`, error);
				}
			}
		} finally {
			cronRunning = false;
		}
	};

	const flushCollected = async (message: Message, runtime: ConversationRuntime): Promise<void> => {
		collectTimers.delete(runtime.channelKey);
		try {
			const isDm = isDmChannel(message.channel);
			const queued = await runtime.queueLatestTrigger({
				channelTrigger: getChannelTriggerSetting(config, settings, runtime.channelKey, isDm).value,
			});
			if (!queued) return;
			// The captured message is only a channel handle; drainJobs fetches the trigger record's message id for replies.
			await drainJobs(message, runtime);
		} catch (error) {
			console.error("Discord collect flush failed", error);
			await runtime.appendError(error instanceof Error ? error.message : String(error));
		}
	};

	const scheduleCollect = (message: Message, runtime: ConversationRuntime): void => {
		const existing = collectTimers.get(runtime.channelKey);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			void flushCollected(message, runtime);
		}, config.discord.collectDebounceMs);
		collectTimers.set(runtime.channelKey, timer);
	};

	const onMessageCreate = async (message: Message) => {
		if (!isAllowedMessage(config, message, client.user.id)) return;
		let runtime: ConversationRuntime;
		try {
			runtime = await getRuntime(message);
			const isDm = isDmChannel(message.channel);
			const channelTrigger = getChannelTriggerSetting(config, settings, runtime.channelKey, isDm);
			const input = await toInboundInput(config, message, client.user.id);
			const control = runtime.parseControlCommand(input);
			if (control) {
				await runtime.noteControlCommand(input, control);
				const text = await applyControlCommand({
					control,
					runtime,
					familiarAgent,
					settings,
					channelTrigger,
					isDm,
					activeAgentOwner,
					restart: options.restart,
				});
				const messageIds = await sendReply(config, message, text);
				await runtime.noteOutbound({ text, messageIds, control: control.command });
				return;
			}
			const dispatchMode = getDispatchMode(config, message);
			const shouldTrySteer =
				dispatchMode === "steer" && runtime.hasActiveJob() && activeAgentOwner === runtime.channelKey;
			const { record } = await runtime.ingestInbound(input, {
				mode: dispatchMode === "collect" || shouldTrySteer ? "collect" : "queue",
				channelTrigger: channelTrigger.value,
			});
			const canSteer =
				shouldTrySteer &&
				canSteerFromRecord(config, message, runtime, record, activeAgentOwner, channelTrigger.value);
			if (canSteer) {
				familiarAgent.steer(runtime.channelKey, runtime.buildSteerPromptForRecord(record));
				return;
			}
			if (shouldTrySteer) {
				await runtime.queueLatestTrigger({ channelTrigger: channelTrigger.value });
			}
			if (dispatchMode === "collect") {
				scheduleCollect(message, runtime);
				return;
			}
			await drainJobs(message, runtime);
		} catch (error) {
			console.error("Discord message handling failed", error);
			const channelKey = runtimeKeyFromMessage(message);
			const existingRuntime = await runtimes.get(channelKey)?.catch(() => undefined);
			await existingRuntime?.appendError(error instanceof Error ? error.message : String(error));
			await sendReply(config, message, "I hit an error while handling that message.");
		}
	};

	const onInteractionCreate = async (interaction: Interaction) => {
		if (interaction.isAutocomplete()) {
			if (interaction.commandName !== FAMILIAR_COMMAND_NAME) return;
			if (!isAllowedInteractionChannel(config, interaction)) {
				await interaction.respond([]);
				return;
			}
			await interaction.respond(getAutocompleteChoices(config, interaction)).catch((error) => {
				console.error("Discord autocomplete response failed", error);
			});
			return;
		}
		if (!interaction.isChatInputCommand()) return;
		if (interaction.commandName !== FAMILIAR_COMMAND_NAME) return;
		if (!isAllowedInteractionChannel(config, interaction)) {
			await interaction.reply({
				content: "This Familiar command is owner-only for configured channels.",
				flags: EPHEMERAL_REPLY,
			});
			return;
		}
		let runtime: ConversationRuntime | undefined;
		try {
			await interaction.deferReply({ flags: EPHEMERAL_REPLY });
			runtime = await getInteractionRuntime(interaction);
			const isDm = isDmChannel(interaction.channel);
			const channelTrigger = getChannelTriggerSetting(config, settings, runtime.channelKey, isDm);
			const input = inboundInputFromInteraction(interaction);
			const control = runtime.parseControlCommand(input);
			if (!control) throw new Error("Unsupported Familiar command.");
			await runtime.noteControlCommand(input, control);
			const text = await applyControlCommand({
				control,
				runtime,
				familiarAgent,
				settings,
				channelTrigger,
				isDm,
				activeAgentOwner,
				restart: options.restart,
			});
			const messageIds = await replyEphemeral(interaction, text);
			await runtime.noteOutbound({ text, messageIds, control: control.command });
		} catch (error) {
			await runtime?.appendError(error instanceof Error ? error.message : String(error));
			await replyInteractionError(interaction, error);
		}
	};

	await registerFamiliarApplicationCommand(client);
	client.on(Events.MessageCreate, onMessageCreate);
	client.on(Events.InteractionCreate, onInteractionCreate);
	client.on(Events.Error, (error) => console.error("Discord client error", error));
	client.on(Events.Warn, (warning) => console.warn("Discord warning", warning));
	client.ws.on("close" as any, (event: unknown) => {
		console.warn("Discord websocket closed; discord.js will reconnect when possible", event);
	});
	schedulerState = await loadSchedulerState(config.workspace.dataDir);
	const tickHeartbeat = () => {
		void runHeartbeat().catch((error) => console.error("Heartbeat tick failed", error));
	};
	const rearmHeartbeat = (): void => {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		if (config.heartbeat.enabled) {
			heartbeatTimer = setInterval(tickHeartbeat, Math.min(config.heartbeat.intervalMs, 60_000));
		}
	};
	if (config.heartbeat.enabled) {
		await initializeHeartbeatState((await getOwnerDmSession()).runtime);
		rearmHeartbeat();
		tickHeartbeat();
	}
	if (config.cron.enabled && config.cron.jobs.some((job) => job.enabled)) {
		const runCronTick = () => {
			void tickCron().catch((error) => console.error("Cron tick failed", error));
		};
		cronTimer = setInterval(runCronTick, config.cron.pollMs);
		runCronTick();
	}

	return {
		client,
		getWebSessions,
		getRuntimeForWebChannel,
		runPromptForWeb: promptForRuntime,
		abortWebRuntime(runtime: ConversationRuntime): void {
			familiarAgent.requestSoftStop(runtime.channelKey);
		},
		getActiveRuntimeKey(): string | undefined {
			return activeAgentOwner;
		},
		rearmHeartbeat,
		async stop(): Promise<void> {
			client.off(Events.MessageCreate, onMessageCreate);
			client.off(Events.InteractionCreate, onInteractionCreate);
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			if (cronTimer) clearInterval(cronTimer);
			for (const timer of collectTimers.values()) clearTimeout(timer);
			collectTimers.clear();
			const resolvedRuntimes = await Promise.all(
				[...runtimes.values()].map((runtime) => runtime.catch(() => undefined)),
			);
			await Promise.all(resolvedRuntimes.flatMap((runtime) => (runtime ? [runtime.disconnect()] : [])));
			client.destroy();
		},
	};
}
