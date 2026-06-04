import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import type { FamiliarAgentReply } from "../agent/factory.js";
import type { Config } from "../config/index.js";
import { messageId } from "../conversation/ids.js";
import {
	type AgentEventSummary,
	createAgentEventRecorder,
	storedAgentEventFromAgentEvent,
	updateAgentEventSummary,
} from "../runtime/agent-events.js";
import type { ConversationRuntime } from "../runtime/conversation-runtime.js";
import { isHeartbeatDue } from "../runtime/scheduler.js";
import { parseOutboundReply } from "./send.js";

export const HEARTBEAT_SKIPPED = Symbol("heartbeat-skipped");
export const CRON_SKIPPED = Symbol("cron-skipped");

export function isCanceledJob(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "CanceledJobError" || error.name === "AbortError" || /aborted|abort/i.test(error.message);
}

export function canceledJobError(): Error {
	const error = new Error("Job was canceled before completion.");
	error.name = "CanceledJobError";
	return error;
}

export function scheduledUserMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

export function heartbeatStillDue(
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

export async function runAgentTurn<R extends FamiliarAgentReply>(
	jobKey: string,
	runtime: ConversationRuntime,
	prompt: (
		onEvent: (event: AgentEvent) => Promise<void>,
	) => Promise<R | typeof HEARTBEAT_SKIPPED | typeof CRON_SKIPPED>,
): Promise<{
	reply: R;
	parsedReply: ReturnType<typeof parseOutboundReply>;
	summary: AgentEventSummary;
	assistantMessageId: string;
} | null> {
	const assistantMessageId = messageId();
	const summary: AgentEventSummary = { thinking: "" };
	const recorder = createAgentEventRecorder((storedEvent) =>
		runtime.noteAgentEvent(jobKey, assistantMessageId, storedEvent, { notify: false }),
	);
	let reply: R | typeof HEARTBEAT_SKIPPED | typeof CRON_SKIPPED;
	try {
		reply = await prompt(async (event) => {
			updateAgentEventSummary(summary, event);
			const storedEvent = storedAgentEventFromAgentEvent(event);
			if (storedEvent) {
				runtime.publishAgentEvent(jobKey, assistantMessageId, storedEvent);
				await recorder.record(storedEvent);
			}
		});
	} finally {
		await recorder.flush();
	}
	if (reply === HEARTBEAT_SKIPPED || reply === CRON_SKIPPED) return null;
	return {
		reply,
		parsedReply: parseOutboundReply(reply.text),
		summary,
		assistantMessageId,
	};
}
