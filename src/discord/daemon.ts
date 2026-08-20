import {
	type AutocompleteInteraction,
	type ChatInputCommandInteraction,
	type Client,
	type DMChannel,
	Events,
	type Interaction,
	type Message,
} from "discord.js";
import type { FamiliarAgent } from "../agent/factory.js";
import type { Config } from "../config/index.js";
import type { SettingsStore } from "../config/settings.js";
import { chatChannelKey } from "../conversation/chat-log.js";
import { saveOwnerIdentity } from "../conversation/owner-identity.js";
import type { RestartHandler } from "../lifecycle/control.js";
import type { MemoryService } from "../memory/service.js";
import type { AgentCore, DiscordWebSession } from "../runtime/agent-core.js";
import { thinkingDurationMs } from "../runtime/agent-events.js";
import { applyControlCommand } from "../runtime/control-actions.js";
import type { ConversationRuntime } from "../runtime/conversation-runtime.js";
import type { SchedulerDeliverySink } from "../runtime/scheduler-runner.js";
import { isCanceledJob, runAgentTurn } from "../runtime/turn.js";
import {
	buildChannelRef,
	type DiscordChatChannel,
	fetchMessageAnchor,
	getChannelRef,
	isDmChannel,
	runtimeKeyFromMessage,
} from "./channel.js";
import { isAllowedMessage, withReadyClient } from "./client.js";
import {
	EPHEMERAL_REPLY,
	FAMILIAR_COMMAND_NAME,
	getAutocompleteChoices,
	inboundInputFromInteraction,
	isAllowedInteractionChannel,
	registerFamiliarApplicationCommand,
	replyEphemeral,
	replyInteractionError,
} from "./commands.js";
import { canSteerFromRecord, getChannelTriggerSetting, getDispatchMode, toInboundInput } from "./inbound.js";
import { sendChannelMessage, sendDiscordAttachments, sendReply } from "./send.js";

export interface DiscordDaemon {
	stop(): Promise<void>;
}

const RETRY_MS = 15_000;

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

export function startDiscordDaemon(
	config: Config,
	token: string,
	familiarAgent: FamiliarAgent,
	settings: SettingsStore,
	_memoryService: MemoryService | undefined,
	core: AgentCore,
	options: { restart?: RestartHandler } = {},
): DiscordDaemon {
	let client: Client<true> | undefined;
	let session: ConnectedSession | undefined;
	let stopped = false;
	let retryTimer: NodeJS.Timeout | undefined;
	const collectTimers = new Map<string, NodeJS.Timeout>();

	const getRuntime = async (message: Message): Promise<ConversationRuntime> => {
		return core.getRuntimeForChannel(getChannelRef(message));
	};

	const getInteractionRuntime = async (
		interaction: ChatInputCommandInteraction | AutocompleteInteraction,
	): Promise<ConversationRuntime> => {
		const channel = interaction.channel;
		if (!channel || !interaction.channelId) throw new Error("Discord interaction has no channel");
		return core.getRuntimeForChannel(buildChannelRef(channel, interaction.channelId));
	};

	interface ConnectedSession {
		onMessageCreate: (message: Message) => Promise<void>;
		onInteractionCreate: (interaction: Interaction) => Promise<void>;
		getOwnerDmSession: () => Promise<{ runtime: ConversationRuntime }>;
		getWebSessions: () => Promise<DiscordWebSession[]>;
		liveSink: SchedulerDeliverySink;
	}

	const createConnectedSession = (client: Client<true>): ConnectedSession => {
		let ownerDmChannelPromise: Promise<DMChannel> | undefined;

		const getOwnerDmChannel = (): Promise<DMChannel> => {
			if (!ownerDmChannelPromise) {
				ownerDmChannelPromise = client.users
					.createDM(config.discord.ownerId)
					.then(async (dm) => {
						try {
							await saveOwnerIdentity(config.workspace.dataDir, {
								botUserId: client.user.id,
								dmChannelId: dm.id,
							});
						} catch (error) {
							console.error("failed to persist owner identity", error);
						}
						return dm;
					})
					.catch((error) => {
						ownerDmChannelPromise = undefined;
						throw error;
					});
			}
			return ownerDmChannelPromise;
		};

		const getWebSessions = async (): Promise<DiscordWebSession[]> => {
			const dmChannel = await getOwnerDmChannel();
			const dmRef = buildChannelRef(dmChannel, dmChannel.id);
			const sessions: DiscordWebSession[] = [
				{ key: chatChannelKey(dmRef), label: "Main Chat", channel: dmRef, isDefault: true },
			];
			const fetched = await Promise.all(
				config.discord.allowedChannels.map((channelId) => client.channels.fetch(channelId).catch(() => undefined)),
			);
			for (const [index, channel] of fetched.entries()) {
				if (!channel) continue;
				const ref = buildChannelRef(channel as DiscordChatChannel, config.discord.allowedChannels[index]);
				sessions.push({
					key: chatChannelKey(ref),
					label: ref.channelName || `Discord ${ref.scope}`,
					channel: ref,
				});
			}
			return sessions;
		};

		const getOwnerDmSession = async (): Promise<{ runtime: ConversationRuntime }> => {
			const dmChannel = await getOwnerDmChannel();
			const runtime = await core.getRuntimeForChannel(buildChannelRef(dmChannel, dmChannel.id));
			return { runtime };
		};

		const liveSink: SchedulerDeliverySink = {
			async deliver({ reply, parsedReply }) {
				const channel = await getOwnerDmChannel();
				return parsedReply.silent
					? await sendDiscordAttachments(token, channel.id, reply.attachments)
					: await sendChannelMessage(config, token, channel, parsedReply.text, reply.attachments);
			},
		};

		const drainJobs = async (message: Message, runtime: ConversationRuntime): Promise<void> => {
			for (;;) {
				const dispatch = runtime.beginNextJob();
				if (!dispatch) return;
				const stopTyping = startTypingIndicator(message);
				try {
					const turn = await runAgentTurn(dispatch.job.jobId, runtime, (onEvent) =>
						core.promptForRuntime(runtime, dispatch.job.jobId, dispatch.prompt, dispatch.attachments, onEvent),
					);
					if (!turn) return;
					const { reply, parsedReply, summary, assistantMessageId } = turn;
					const replyAnchor = await fetchMessageAnchor(message, dispatch.triggerMessageId);
					const messageIds = parsedReply.silent
						? await sendDiscordAttachments(token, replyAnchor.channelId, reply.attachments)
						: await sendReply(
								config,
								token,
								replyAnchor,
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
					const messageIds = await sendReply(config, token, replyAnchor, fallback, dispatch.triggerMessageId);
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
						activeAgentOwner: core.activeOwner,
						restart: options.restart,
					});
					const messageIds = await sendReply(config, token, message, text);
					await runtime.noteOutbound({ text, messageIds, control: control.command });
					return;
				}
				const dispatchMode = getDispatchMode(config, message);
				const shouldTrySteer =
					dispatchMode === "steer" && runtime.hasActiveJob() && core.activeOwner === runtime.channelKey;
				const { record } = await runtime.ingestInbound(input, {
					mode: dispatchMode === "collect" || shouldTrySteer ? "collect" : "queue",
					channelTrigger: channelTrigger.value,
				});
				const canSteer =
					shouldTrySteer &&
					canSteerFromRecord(config, message, runtime, record, core.activeOwner, channelTrigger.value);
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
				const existingRuntime = await core.peekRuntime(channelKey);
				await existingRuntime?.appendError(error instanceof Error ? error.message : String(error));
				await sendReply(config, token, message, "I hit an error while handling that message.");
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
					activeAgentOwner: core.activeOwner,
					restart: options.restart,
				});
				const messageIds = await replyEphemeral(interaction, text);
				await runtime.noteOutbound({ text, messageIds, control: control.command });
			} catch (error) {
				await runtime?.appendError(error instanceof Error ? error.message : String(error));
				await replyInteractionError(interaction, error);
			}
		};

		return { onMessageCreate, onInteractionCreate, getOwnerDmSession, getWebSessions, liveSink };
	};

	const onClientError = (error: Error) => console.error("Discord client error", error);
	const onClientWarn = (warning: string) => console.warn("Discord warning", warning);
	const onWsClose = (event: unknown) => {
		console.warn("Discord websocket closed; discord.js will reconnect when possible", event);
	};
	const connect = async (): Promise<void> => {
		if (stopped) return;
		try {
			client = await withReadyClient(token);
			console.log(`Discord connected as ${client.user.tag}`);
			await registerFamiliarApplicationCommand(client);
			session = createConnectedSession(client);
			client.on(Events.MessageCreate, session.onMessageCreate);
			client.on(Events.InteractionCreate, session.onInteractionCreate);
			client.on(Events.Error, onClientError);
			client.on(Events.Warn, onClientWarn);
			client.ws.on("close" as any, onWsClose);
			core.attachDiscord({
				botUserId: client.user.id,
				resolveDefaultSession: session.getOwnerDmSession,
				getWebSessions: session.getWebSessions,
				delivery: session.liveSink,
			});
		} catch (error) {
			console.error("Discord connect failed; retrying in background", error);
			if (!stopped) retryTimer = setTimeout(() => void connect(), RETRY_MS);
		}
	};
	void connect();

	return {
		async stop(): Promise<void> {
			stopped = true;
			if (retryTimer) clearTimeout(retryTimer);
			const liveClient = client;
			if (liveClient && session) {
				liveClient.off(Events.MessageCreate, session.onMessageCreate);
				liveClient.off(Events.InteractionCreate, session.onInteractionCreate);
				liveClient.off(Events.Error, onClientError);
				liveClient.off(Events.Warn, onClientWarn);
				liveClient.ws.off("close" as any, onWsClose);
			}
			for (const timer of collectTimers.values()) clearTimeout(timer);
			collectTimers.clear();
			liveClient?.destroy();
		},
	};
}
