import type { FamiliarAgent } from "../agent/factory.js";
import type { Config } from "../config/index.js";
import type { SettingsStore } from "../config/settings.js";
import { type ChatChannelRef, chatChannelKey } from "../conversation/chat-log.js";
import type { RestartHandler } from "../lifecycle/control.js";
import { materializeInboundAttachments } from "../media/inbound-attachments.js";
import type { AgentCore, ChatSession } from "../runtime/agent-core.js";
import { thinkingDurationMs } from "../runtime/agent-events.js";
import { applyControlCommand, getChannelTriggerSetting } from "../runtime/control-actions.js";
import type { ConversationRuntime, InboundMessageInput } from "../runtime/conversation-runtime.js";
import type { SchedulerDeliverySink } from "../runtime/scheduler-runner.js";
import { isCanceledJob, runAgentTurn } from "../runtime/turn.js";
import { parseQqMessageEvent } from "./inbound.js";
import { createOneBotClient } from "./onebot.js";
import { sendQqMessage } from "./send.js";

export interface QqDaemon {
	stop(): Promise<void>;
}

export function startQqDaemon(
	config: Config,
	familiarAgent: FamiliarAgent,
	settings: SettingsStore,
	core: AgentCore,
	options: { restart?: RestartHandler; WebSocketImpl?: typeof WebSocket } = {},
): QqDaemon {
	const { wsUrl, ownerId } = config.qq;
	if (!wsUrl || !ownerId) throw new Error("QQ daemon requires qq.ws_url and qq.owner_id");
	const dmRef: ChatChannelRef = { service: "qq", scope: "dm", channelId: ownerId };
	const collectTimers = new Map<string, NodeJS.Timeout>();

	const liveSink: SchedulerDeliverySink = {
		async deliver({ reply, parsedReply }) {
			return sendQqMessage(client, dmRef, parsedReply.silent ? "" : parsedReply.text, reply.attachments);
		},
	};

	const getWebSessions = async (): Promise<ChatSession[]> => {
		const sessions: ChatSession[] = [
			{ key: chatChannelKey(dmRef), label: "QQ Chat", channel: dmRef, isDefault: true },
		];
		for (const groupId of config.qq.allowedGroups) {
			const name = await client
				.callAction<{ group_name?: string }>("get_group_info", { group_id: Number(groupId) })
				.then((data) => (typeof data?.group_name === "string" && data.group_name ? data.group_name : undefined))
				.catch(() => undefined);
			const ref: ChatChannelRef = { service: "qq", scope: "channel", channelId: groupId, channelName: name };
			sessions.push({ key: chatChannelKey(ref), label: name ?? `QQ 群 ${groupId}`, channel: ref });
		}
		return sessions;
	};

	const onConnected = async (): Promise<void> => {
		try {
			const info = await client.callAction<{ user_id?: number | string }>("get_login_info");
			const botUserId = info?.user_id === undefined ? undefined : String(info.user_id);
			console.log(`QQ connected via OneBot as ${botUserId ?? "unknown"}`);
			await core.attachPlatform({
				service: "qq",
				ownerId,
				botUserId,
				resolveDefaultSession: async () => ({ runtime: await core.getRuntimeForChannel(dmRef) }),
				getWebSessions,
				delivery: liveSink,
			});
		} catch (error) {
			console.error("QQ login info failed", error);
		}
	};

	const drainJobs = async (ref: ChatChannelRef, runtime: ConversationRuntime): Promise<void> => {
		for (;;) {
			const dispatch = runtime.beginNextJob();
			if (!dispatch) return;
			try {
				const turn = await runAgentTurn(dispatch.job.jobId, runtime, (onEvent) =>
					core.promptForRuntime(runtime, dispatch.job.jobId, dispatch.prompt, dispatch.attachments, onEvent),
				);
				if (!turn) return;
				const { reply, parsedReply, summary, assistantMessageId } = turn;
				let messageIds: string[] = [];
				try {
					messageIds = await sendQqMessage(
						client,
						ref,
						parsedReply.silent ? "" : parsedReply.text,
						reply.attachments,
					);
				} catch (error) {
					// A failed QQ send doesn't fail the job — the reply persists with no messageIds and stays visible in the WebUI.
					console.error("QQ send failed", error);
				}
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
				const messageIds = await sendQqMessage(client, ref, fallback).catch(() => [] as string[]);
				await runtime.noteOutbound({
					text: fallback,
					messageIds,
					replyToMessageId: dispatch.triggerMessageId,
					jobId: dispatch.job.jobId,
				});
			}
		}
	};

	const flushCollected = async (ref: ChatChannelRef, runtime: ConversationRuntime): Promise<void> => {
		collectTimers.delete(runtime.channelKey);
		try {
			const queued = await runtime.queueLatestTrigger({
				channelTrigger: getChannelTriggerSetting(config, settings, runtime.channelKey, ref.scope === "dm").value,
			});
			if (!queued) return;
			await drainJobs(ref, runtime);
		} catch (error) {
			console.error("QQ collect flush failed", error);
			await runtime.appendError(error instanceof Error ? error.message : String(error));
		}
	};

	const scheduleCollect = (ref: ChatChannelRef, runtime: ConversationRuntime): void => {
		const existing = collectTimers.get(runtime.channelKey);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			void flushCollected(ref, runtime);
		}, config.discord.collectDebounceMs);
		collectTimers.set(runtime.channelKey, timer);
	};

	const onEvent = async (event: Record<string, unknown>): Promise<void> => {
		if (event.post_type !== "message") return;
		let runtime: ConversationRuntime | undefined;
		try {
			const parsed = parseQqMessageEvent(event, String(event.self_id ?? ""));
			if (parsed.messageType === "private" && parsed.input.authorId !== ownerId) return;
			if (parsed.messageType === "group" && !config.qq.allowedGroups.includes(parsed.channelId)) return;
			const ref: ChatChannelRef =
				parsed.messageType === "private" ? dmRef : { service: "qq", scope: "channel", channelId: parsed.channelId };
			const isDm = ref.scope === "dm";
			runtime = await core.getRuntimeForChannel(ref);
			const channelTrigger = getChannelTriggerSetting(config, settings, runtime.channelKey, isDm);
			const input: InboundMessageInput = {
				...parsed.input,
				attachments: await materializeInboundAttachments(config, parsed.attachments),
			};
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
				const messageIds = await sendQqMessage(client, ref, text).catch(() => [] as string[]);
				await runtime.noteOutbound({ text, messageIds, control: control.command });
				return;
			}
			// ponytail: dispatch mode, trigger default, and debounce reuse the discord.* config keys — split [qq] keys when someone needs them to differ.
			const dispatchMode = isDm ? config.discord.dmMode : config.discord.channelMode;
			const shouldTrySteer =
				dispatchMode === "steer" && runtime.hasActiveJob() && core.activeOwner === runtime.channelKey;
			const { record } = await runtime.ingestInbound(input, {
				mode: dispatchMode === "collect" || shouldTrySteer ? "collect" : "queue",
				channelTrigger: channelTrigger.value,
			});
			const canSteer =
				shouldTrySteer &&
				(isDm
					? record.authorId === ownerId && !record.isBot
					: channelTrigger.value === "always" || record.mentionedBot);
			if (canSteer) {
				familiarAgent.steer(runtime.channelKey, runtime.buildSteerPromptForRecord(record));
				return;
			}
			if (shouldTrySteer) {
				await runtime.queueLatestTrigger({ channelTrigger: channelTrigger.value });
			}
			if (dispatchMode === "collect") {
				scheduleCollect(ref, runtime);
				return;
			}
			await drainJobs(ref, runtime);
		} catch (error) {
			console.error("QQ message handling failed", error);
			await runtime?.appendError(error instanceof Error ? error.message : String(error));
		}
	};

	const client = createOneBotClient({
		wsUrl,
		accessToken: config.qq.token,
		onOpen: () => void onConnected(),
		onEvent: (event) => void onEvent(event),
		WebSocketImpl: options.WebSocketImpl,
	});

	return {
		async stop(): Promise<void> {
			for (const timer of collectTimers.values()) clearTimeout(timer);
			collectTimers.clear();
			client.stop();
		},
	};
}
