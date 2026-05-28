import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AutocompleteInteraction,
	type ChatInputCommandInteraction,
	type Client,
	Events,
	type Interaction,
	type Message,
} from "discord.js";
import type { FamiliarAgent, FamiliarAgentReply, FamiliarPromptOptions } from "./agent.js";
import { thinkingDurationMs } from "./agent-events.js";
import type { StoredAttachment } from "./chat-log.js";
import { type ChatChannelRef, chatChannelKey, createChatLog } from "./chat-log.js";
import type { Config } from "./config.js";
import type { RestartHandler } from "./control.js";
import {
	buildChannelRef,
	type DiscordChatChannel,
	fetchMessageAnchor,
	getChannelRef,
	isDmChannel,
	runtimeKeyFromMessage,
} from "./discord/channel.js";
import { isAllowedMessage, withReadyClient } from "./discord/client.js";
import {
	EPHEMERAL_REPLY,
	FAMILIAR_COMMAND_NAME,
	formatCommandResponse,
	getAutocompleteChoices,
	inboundInputFromInteraction,
	isAllowedInteractionChannel,
	registerFamiliarApplicationCommand,
	replyEphemeral,
	replyInteractionError,
} from "./discord/commands.js";
import { canSteerFromRecord, getChannelTriggerSetting, getDispatchMode, toInboundInput } from "./discord/inbound.js";
import {
	buildRawFiles,
	postDiscordAttachments,
	sendChannelMessage,
	sendDiscordAttachments,
	sendReply,
} from "./discord/send.js";
import {
	CRON_SKIPPED,
	canceledJobError,
	HEARTBEAT_SKIPPED,
	heartbeatStillDue,
	isCanceledJob,
	runAgentTurn,
	scheduledUserMessage,
} from "./discord/turn.js";
import { promptImagesFromAttachments } from "./inbound-attachments.js";
import type { MemoryService } from "./memory/service.js";
import { ConversationRuntime } from "./runtime.js";
import {
	appendSchedulerLog,
	buildCronInjectionText,
	buildHeartbeatInjectionText,
	type CronJobConfig,
	dueCronSlot,
	formatIdleDuration,
	loadSchedulerState,
	type SchedulerState,
	saveSchedulerState,
} from "./scheduler.js";
import { type EffectiveSetting, formatSetting, type SettingsStore } from "./settings.js";

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

export const __test = {
	buildRawFiles,
	postDiscordAttachments,
};

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
				const turn = await runAgentTurn(dispatch.job.jobId, runtime, (onEvent) =>
					promptForRuntime(runtime, dispatch.job.jobId, dispatch.prompt, dispatch.attachments, onEvent),
				);
				if (!turn) return;
				const { reply, parsedReply, summary, assistantMessageId } = turn;
				const replyAnchor = await fetchMessageAnchor(message, dispatch.triggerMessageId);
				const messageIds = parsedReply.silent
					? await sendDiscordAttachments(client.rest, replyAnchor.channelId, reply.attachments)
					: await sendReply(
							config,
							client.rest,
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
				const messageIds = await sendReply(config, client.rest, replyAnchor, fallback, dispatch.triggerMessageId);
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

			const turn = await runAgentTurn("heartbeat", heartbeatRuntime, (onEvent) =>
				promptScheduledMessage(
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
							`heartbeat stirred after ${formatIdleDuration(queuedNow - latestUserInteractionAt)}`,
						);
						return scheduledUserMessage(text, queuedNow);
					},
					onEvent,
					{ skipAmbient: true },
				),
			);
			if (!turn) return;
			const { reply, parsedReply, summary, assistantMessageId } = turn;
			const messageIds = parsedReply.silent
				? await sendDiscordAttachments(client.rest, channel.id, reply.attachments)
				: await sendChannelMessage(config, client.rest, channel, parsedReply.text, reply.attachments);
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

		const jobKey = `cron:${job.id}`;
		const turn = await runAgentTurn(jobKey, runtime, (onEvent) =>
			promptScheduledMessage(
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
				onEvent,
				{ skipAmbient: true },
			),
		);
		if (!turn) {
			await appendSchedulerLog(config.workspace.dataDir, {
				type: "cron_skipped",
				jobId: job.id,
				slot,
				deliveryMode: job.deliveryMode,
				detail: "already completed before prompt",
			});
			return;
		}
		const { reply, parsedReply, summary, assistantMessageId } = turn;
		const messageIds = parsedReply.silent
			? await sendDiscordAttachments(client.rest, channel.id, reply.attachments)
			: await sendChannelMessage(config, client.rest, channel, parsedReply.text, reply.attachments);
		await runtime.noteOutbound({
			text: parsedReply.text,
			messageIds,
			webMessageId: assistantMessageId,
			attachments: reply.attachments,
			thinking: summary.thinking,
			thinkingMs: thinkingDurationMs(summary),
			silent: parsedReply.silent,
			jobId: jobKey,
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
				const messageIds = await sendReply(config, client.rest, message, text);
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
			await sendReply(config, client.rest, message, "I hit an error while handling that message.");
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
