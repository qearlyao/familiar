import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import type { FamiliarAgent, FamiliarAgentReply, FamiliarPromptOptions } from "../agent.js";
import type { Config } from "../config.js";
import {
	CRON_SKIPPED,
	HEARTBEAT_SKIPPED,
	heartbeatStillDue,
	runAgentTurn,
	scheduledUserMessage,
} from "../discord/turn.js";
import { thinkingDurationMs } from "./agent-events.js";
import type { ConversationRuntime } from "./conversation-runtime.js";
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

type SchedulerAgentWork = {
	promptScheduledMessage(
		runtime: ConversationRuntime,
		buildMessage: () =>
			| AgentMessage
			| typeof HEARTBEAT_SKIPPED
			| typeof CRON_SKIPPED
			| Promise<AgentMessage | typeof HEARTBEAT_SKIPPED | typeof CRON_SKIPPED>,
		onEvent?: (event: AgentEvent) => void | Promise<void>,
		options?: FamiliarPromptOptions,
	): Promise<FamiliarAgentReply | typeof HEARTBEAT_SKIPPED | typeof CRON_SKIPPED>;
	readonly activeOwner: string | undefined;
};

export interface SchedulerDeliverySink {
	deliver(options: { reply: FamiliarAgentReply; parsedReply: { text: string; silent: boolean } }): Promise<string[]>;
}

export interface SchedulerRunnerDeps {
	config: Config;
	agentWork: SchedulerAgentWork;
	familiarAgent: FamiliarAgent;
	resolveDefaultSession: () => Promise<{ runtime: ConversationRuntime }>;
	delivery: SchedulerDeliverySink;
}

export interface SchedulerRunner {
	start(): Promise<void>;
	rearmHeartbeat(): void;
	stop(): void;
}

export function createSchedulerRunner(deps: SchedulerRunnerDeps): SchedulerRunner {
	const { config, agentWork, familiarAgent, resolveDefaultSession, delivery } = deps;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	let cronTimer: NodeJS.Timeout | undefined;
	let heartbeatQueued = false;
	let cronRunning = false;
	let schedulerState: SchedulerState = { cron: {} };

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

	const runHeartbeat = async (): Promise<void> => {
		if (!config.heartbeat.enabled) return;
		if (agentWork.activeOwner) return;
		if (heartbeatQueued) return;
		heartbeatQueued = true;
		let runtime: ConversationRuntime | undefined;
		try {
			const session = await resolveDefaultSession();
			runtime = session.runtime;
			const heartbeatRuntime = session.runtime;
			const now = Date.now();
			if (heartbeatRuntime.hasLiveWork()) return;
			const lastUserInteractionAt = heartbeatRuntime.getLastUserInteractionAt();
			if (!heartbeatStillDue(config, now, lastUserInteractionAt, schedulerState.heartbeat?.lastFiredAt)) {
				return;
			}

			const turn = await runAgentTurn("heartbeat", heartbeatRuntime, (onEvent) =>
				agentWork.promptScheduledMessage(
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
			const messageIds = await delivery.deliver({ reply, parsedReply });
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

	const runCronJob = async (job: CronJobConfig, slot: string, runtime: ConversationRuntime): Promise<void> => {
		await appendSchedulerLog(config.workspace.dataDir, {
			type: "cron_due",
			jobId: job.id,
			slot,
			deliveryMode: job.deliveryMode,
		});
		if (job.deliveryMode === "follow_up" && agentWork.activeOwner === runtime.channelKey) {
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
			agentWork.promptScheduledMessage(
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
		const messageIds = await delivery.deliver({ reply, parsedReply });
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
			const session = await resolveDefaultSession();
			for (const job of config.cron.jobs) {
				const slot = dueCronSlot(job, schedulerState.cron[job.id], Date.now());
				if (!slot) continue;
				try {
					await runCronJob(job, slot, session.runtime);
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

	const start = async (): Promise<void> => {
		schedulerState = await loadSchedulerState(config.workspace.dataDir);
		if (config.heartbeat.enabled) {
			await initializeHeartbeatState((await resolveDefaultSession()).runtime);
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
	};

	const stop = (): void => {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		if (cronTimer) clearInterval(cronTimer);
	};

	return { start, rearmHeartbeat, stop };
}
