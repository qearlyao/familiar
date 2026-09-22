import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import type { FamiliarAgent, FamiliarAgentReply, FamiliarPromptOptions } from "../agent/factory.js";
import type { StoredAttachment } from "../conversation/chat-log.js";
import { promptImagesFromAttachments } from "../media/inbound-attachments.js";
import type { ConversationRuntime } from "./conversation-runtime.js";
import { CRON_SKIPPED, canceledJobError, HEARTBEAT_SKIPPED } from "./turn.js";

export function createAgentWorkQueue(deps: { familiarAgent: FamiliarAgent }) {
	let activeAgentOwner: string | undefined;
	let agentWorkQueue = Promise.resolve();

	const enqueueAgentWork = <T>(work: () => Promise<T>): Promise<T> => {
		const run = agentWorkQueue.then(work);
		agentWorkQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	const promptForRuntime = async (
		runtime: ConversationRuntime,
		jobId: string,
		prompt: string,
		attachments: StoredAttachment[] = [],
		onEvent?: (event: AgentEvent) => void | Promise<void>,
		onTurnEnd?: () => void | Promise<void>,
	): Promise<FamiliarAgentReply> => {
		return enqueueAgentWork(async () => {
			if (!runtime.hasActiveJob(jobId)) throw canceledJobError();
			activeAgentOwner = runtime.channelKey;
			try {
				const promptImages = await promptImagesFromAttachments(attachments);
				const input = [prompt, promptImages.promptSuffix].filter(Boolean).join("\n");
				const ambientQuery = runtime.ambientQueryForActiveJob(jobId);
				const notes = runtime.notesForActiveJob(jobId);
				const reply = await deps.familiarAgent.prompt(runtime.channelKey, input, promptImages.images, onEvent, {
					...(ambientQuery !== undefined ? { ambientQuery } : {}),
					...(notes.length ? { notes } : {}),
					referenceAttachments: attachments,
					onTurnEnd,
				});
				if (!runtime.hasActiveJob(jobId)) throw canceledJobError();
				return reply;
			} finally {
				if (activeAgentOwner === runtime.channelKey) activeAgentOwner = undefined;
			}
		});
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
		return enqueueAgentWork(async () => {
			const message = await buildMessage();
			if (message === HEARTBEAT_SKIPPED || message === CRON_SKIPPED) return message;
			// a scheduled turn has no slice of its own, so a call kept since the last turn rides along with it
			const pending = runtime.pendingCallNotes();
			activeAgentOwner = runtime.channelKey;
			try {
				const reply = await deps.familiarAgent.promptMessage(runtime.channelKey, message, onEvent, {
					...options,
					...(pending ? { notes: pending.texts } : {}),
				});
				if (pending) await runtime.noteCallsDelivered(pending.throughRecordId);
				return reply;
			} finally {
				if (activeAgentOwner === runtime.channelKey) activeAgentOwner = undefined;
			}
		});
	};

	return {
		promptForRuntime,
		promptScheduledMessage,
		get activeOwner(): string | undefined {
			return activeAgentOwner;
		},
	};
}
