import { randomUUID } from "node:crypto";

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { FamiliarAgent, FamiliarAgentReply } from "../agent/factory.js";
import type { Config } from "../config/index.js";
import { formatSetting } from "../config/settings.js";
import type { StoredAttachment } from "../conversation/chat-log.js";
import { messageId } from "../conversation/ids.js";
import type { RestartHandler } from "../lifecycle/control.js";
import type { AgentCore } from "../runtime/agent-core.js";
import {
	type AgentEventSummary,
	createAgentEventRecorder,
	storedAgentEventFromAgentEvent,
	thinkingDurationMs,
	updateAgentEventSummary,
} from "../runtime/agent-events.js";
import type { ConversationRuntime, ParsedControlCommand } from "../runtime/conversation-runtime.js";
import { parseAgentReply } from "../runtime/silent-marker.js";
import { errorMessage } from "./errors.js";
import type { WebEventHub } from "./event-hub.js";
import { webAttachments } from "./messages.js";

interface WebRuntimeActionsOptions {
	config: Config;
	familiarAgent: FamiliarAgent;
	agentCore: AgentCore;
	eventHub: WebEventHub;
	personaName: string;
	restart?: RestartHandler;
}

export interface WebPromptReply {
	text: string;
	messageId: string;
	thinking: string;
	thinkingMs?: number;
	attachments?: StoredAttachment[];
	silent?: boolean;
}

export interface WebRuntimeActions {
	promptForRuntime(
		runtime: ConversationRuntime,
		jobId: string,
		prompt: string,
		attachments?: StoredAttachment[],
		onTurnEnd?: () => void | Promise<void>,
	): Promise<WebPromptReply>;
	retryLatestAssistant(runtime: ConversationRuntime): Promise<void>;
	deleteLatestAssistant(runtime: ConversationRuntime): Promise<void>;
	editLatestAssistant(runtime: ConversationRuntime, text: string): Promise<void>;
	drainJobs(runtime: ConversationRuntime): Promise<void>;
	applyControlCommand(runtime: ConversationRuntime, control: ParsedControlCommand): Promise<string>;
}

function replyPersistenceFields(reply: WebPromptReply): {
	text: string;
	messageIds: string[];
	webMessageId: string;
	attachments?: StoredAttachment[];
	thinking: string;
	thinkingMs?: number;
	silent?: boolean;
} {
	return {
		text: reply.text,
		messageIds: [reply.messageId],
		webMessageId: reply.messageId,
		attachments: reply.attachments,
		thinking: reply.thinking,
		thinkingMs: reply.thinkingMs,
		silent: reply.silent,
	};
}

export function createWebRuntimeActions(options: WebRuntimeActionsOptions): WebRuntimeActions {
	const { config, familiarAgent, agentCore, eventHub, personaName, restart } = options;
	const { appendAndPublishError, publish, publishDelta } = eventHub;

	const promptAssistantMessage = async (input: {
		runtime: ConversationRuntime;
		jobId: string;
		assistantMessageId: string;
		dispatch: (onEvent: (event: AgentEvent) => void | Promise<void>) => Promise<FamiliarAgentReply>;
		onAssistantStart?: () => void;
	}): Promise<WebPromptReply> => {
		const { runtime, jobId, assistantMessageId } = input;
		const summary: AgentEventSummary = { thinking: "" };
		const recorder = createAgentEventRecorder((storedEvent) =>
			runtime.noteAgentEvent(jobId, assistantMessageId, storedEvent, { notify: false }),
		);
		let started = false;
		let reply: FamiliarAgentReply;
		try {
			reply = await input.dispatch(async (event: AgentEvent) => {
				if (event.type === "message_start" && event.message.role === "assistant" && !started) {
					started = true;
					input.onAssistantStart?.();
				}
				updateAgentEventSummary(summary, event);
				const storedEvent = storedAgentEventFromAgentEvent(event);
				if (storedEvent) {
					runtime.publishAgentEvent(jobId, assistantMessageId, storedEvent);
					await recorder.record(storedEvent);
				}
			});
		} finally {
			await recorder.flush();
		}
		const parsed = parseAgentReply(reply.text);
		const finalText = parsed.silent ? "" : reply.text;
		if (!started) {
			input.onAssistantStart?.();
			if (!parsed.silent) {
				publish({
					type: "message_started",
					channelKey: runtime.channelKey,
					messageId: assistantMessageId,
					role: "assistant",
					who: personaName,
				});
				if (finalText) {
					publishDelta(runtime.channelKey, assistantMessageId, "text", finalText);
				}
			}
		}
		const thinkingMs = thinkingDurationMs(summary);
		publish({
			type: "message_completed",
			channelKey: runtime.channelKey,
			messageId: assistantMessageId,
			thinkingMs,
			attachments: webAttachments(config, reply.attachments),
			silent: parsed.silent || undefined,
		});
		eventHub.markLocallyStreamed(assistantMessageId);
		return {
			text: finalText,
			messageId: assistantMessageId,
			thinking: summary.thinking,
			thinkingMs,
			attachments: reply.attachments,
			silent: parsed.silent,
		};
	};

	const promptForRuntime: WebRuntimeActions["promptForRuntime"] = async (
		runtime,
		jobId,
		prompt,
		attachments = [],
		onTurnEnd,
	) => {
		return promptAssistantMessage({
			runtime,
			jobId,
			assistantMessageId: messageId(),
			dispatch: (onEvent) => agentCore.promptForRuntime(runtime, jobId, prompt, attachments, onEvent, onTurnEnd),
		});
	};

	const retryLatestAssistant = async (runtime: ConversationRuntime): Promise<void> => {
		if (runtime.hasActiveJob()) throw new Error("Cannot retry while a turn is running");
		const target = runtime.latestAssistantRetryTarget();
		if (!target) throw new Error("No assistant message to retry");
		const jobId = randomUUID();
		const assistantMessageId = messageId();
		const replaceMessage = (): void => {
			publish({
				type: "message_replaced",
				channelKey: runtime.channelKey,
				oldMessageId: target.messageId,
				newMessageId: assistantMessageId,
			});
		};
		try {
			const reply = await promptAssistantMessage({
				runtime,
				jobId,
				assistantMessageId,
				onAssistantStart: replaceMessage,
				dispatch: (onEvent) =>
					familiarAgent.retryLastAssistant(runtime.channelKey, onEvent, {
						onTurnEnd: () => {
							publish({
								type: "status",
								channelKey: runtime.channelKey,
								kind: "idle",
							});
						},
					}),
			});
			await runtime.noteAssistantRetry({
				oldMessageId: target.messageId,
				newMessageId: assistantMessageId,
				jobId,
				triggerRecordId: target.triggerRecordId,
			});
			await runtime.noteOutbound({
				...replyPersistenceFields(reply),
				replyToMessageId: target.messageId,
				jobId,
			});
		} catch (error) {
			const message = errorMessage(error);
			await appendAndPublishError(runtime, message);
		}
	};

	const deleteLatestAssistant = async (runtime: ConversationRuntime): Promise<void> => {
		if (runtime.hasActiveJob()) throw new Error("Cannot delete while a turn is running");
		const target = runtime.latestAssistantDeleteTarget();
		if (!target) throw new Error("No assistant message to delete");
		try {
			await familiarAgent.deleteLastAssistant(runtime.channelKey);
			await runtime.noteMessageDelete(target.messageId);
			publish({
				type: "message_deleted",
				channelKey: runtime.channelKey,
				messageId: target.messageId,
			});
		} catch (error) {
			const message = errorMessage(error);
			await appendAndPublishError(runtime, message);
		}
	};

	const editLatestAssistant = async (runtime: ConversationRuntime, text: string): Promise<void> => {
		if (runtime.hasActiveJob()) throw new Error("Cannot edit while a turn is running");
		const trimmed = text.trim();
		if (!trimmed) throw new Error("Edited message cannot be empty");
		const target = runtime.latestAssistantEditTarget();
		if (!target) throw new Error("No assistant message to edit");
		try {
			await familiarAgent.editLastAssistant(runtime.channelKey, trimmed);
			await runtime.noteMessageEdit(target.messageId, trimmed);
		} catch (error) {
			const message = errorMessage(error);
			await appendAndPublishError(runtime, message);
			throw error;
		}
	};

	const drainJobs = async (runtime: ConversationRuntime): Promise<void> => {
		for (;;) {
			const dispatch = runtime.beginNextJob();
			if (!dispatch) return;
			try {
				const reply = await promptForRuntime(
					runtime,
					dispatch.job.jobId,
					dispatch.prompt,
					dispatch.attachments,
					() => {
						publish({
							type: "status",
							channelKey: runtime.channelKey,
							kind: "idle",
						});
					},
				);
				await runtime.completeActiveJob({
					...replyPersistenceFields(reply),
					replyToMessageId: dispatch.triggerMessageId,
				});
			} catch (error) {
				if (!runtime.hasActiveJob(dispatch.job.jobId)) return;
				const message = errorMessage(error);
				await runtime.failActiveJob(message);
				await appendAndPublishError(runtime, message);
			}
		}
	};

	const applyControlCommand = async (runtime: ConversationRuntime, control: ParsedControlCommand): Promise<string> => {
		if (control.command === "stop") {
			await familiarAgent.abort(runtime.channelKey);
			return "Stopped current work.";
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
		if (control.command === "channel-trigger") return "Use Discord /familiar channel-trigger in the channel for now.";
		if (control.command === "status") {
			return [
				runtime.formatStatus(),
				`model: ${formatSetting(familiarAgent.getModel(runtime.channelKey))}`,
				`thinking: ${formatSetting(familiarAgent.getThinkingLevel(runtime.channelKey))}`,
			].join("\n");
		}
		return "Compact is not wired for this runtime yet. I logged the command, but I won't run lossy compaction here.";
	};

	return {
		promptForRuntime,
		retryLatestAssistant,
		deleteLatestAssistant,
		editLatestAssistant,
		drainJobs,
		applyControlCommand,
	};
}
