import { type ChatLogRecord, hiddenWebMessageIds, type StoredAgentEvent, type StoredAttachment } from "../chat-log.js";
import type { Config } from "../config.js";
import { getContactNickname } from "../contact-note.js";
import { publicAttachmentPath } from "../generated-media.js";
import { toUnixMs } from "../ids.js";
import { isRecord } from "../util/guards.js";
import { WEB_USER_NAME, type WebAttachment, type WebMessage, type WebStep, type WebToolEvent } from "./types.js";

export function isUserVisibleRuntimeRecord(record: ChatLogRecord): boolean {
	return record.type !== "runtime" || !["armed", "reset", "stopped"].includes(record.event);
}

export function webAttachments(
	config: Config,
	attachments: StoredAttachment[] | undefined,
): WebAttachment[] | undefined {
	if (!attachments?.length) return undefined;
	return attachments.map((attachment) => ({
		id: attachment.id,
		name: attachment.name,
		kind: attachment.kind,
		mimeType: attachment.mimeType,
		size: attachment.size,
		url: attachment.localPath ? publicAttachmentPath(config, attachment.localPath) : attachment.remoteUrl,
		derivedText: attachmentDerivedText(attachment),
	}));
}

export function attachmentDerivedText(attachment: StoredAttachment): WebAttachment["derivedText"] | undefined {
	if (attachment.derived?.text?.label === "preview") return undefined;
	const text = attachment.derived?.text?.text.trim();
	if (!text) return undefined;
	return {
		label: attachment.derived?.text?.label,
		text,
	};
}

export function toolError(result: unknown): string | undefined {
	if (typeof result === "string") return result;
	if (!isRecord(result)) return undefined;
	if (typeof result.error === "string") return result.error;
	if (typeof result.message === "string") return result.message;
	return undefined;
}

export function toolFromStoredAgentEvent(event: StoredAgentEvent, ts: number): WebToolEvent | undefined {
	if (event.type === "tool_execution_start") {
		return {
			id: event.toolCallId,
			name: event.toolName,
			status: "running",
			args: event.args,
			startedAt: ts,
			updatedAt: ts,
		};
	}
	if (event.type === "tool_execution_update") {
		return {
			id: event.toolCallId,
			name: event.toolName,
			status: "running",
			args: event.args,
			partialResult: event.partialResult,
			updatedAt: ts,
		};
	}
	if (event.type === "tool_execution_end") {
		return {
			id: event.toolCallId,
			name: event.toolName,
			status: event.isError ? "error" : "completed",
			result: event.result,
			error: event.isError ? toolError(event.result) : undefined,
			completedAt: ts,
			updatedAt: ts,
		};
	}
	if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end") {
		return {
			id: event.assistantMessageEvent.toolCall.id,
			name: event.assistantMessageEvent.toolCall.name,
			status: "pending",
			args: event.assistantMessageEvent.toolCall.arguments,
			updatedAt: ts,
		};
	}
	return undefined;
}

export function mergeToolEvent(existing: WebToolEvent | undefined, patch: WebToolEvent): WebToolEvent {
	const terminal = patch.status === "completed" || patch.status === "error";
	return {
		...existing,
		...patch,
		args: patch.args ?? existing?.args,
		partialResult: terminal ? undefined : (patch.partialResult ?? existing?.partialResult),
		result: patch.result ?? existing?.result,
		error: patch.error ?? existing?.error,
		startedAt: existing?.startedAt ?? patch.startedAt,
	};
}

export function stepId(messageId: string, kind: string, index: number): string {
	return `${messageId}-${kind}-${index}`;
}

export function closeOpenContentSteps(steps: WebStep[], now: number): void {
	for (const step of steps) {
		if (step.kind === "thinking" && !step.complete) {
			step.complete = true;
			step.endedAt ??= now;
		}
		if (step.kind === "text" && !step.complete) step.complete = true;
	}
}

export function appendDeltaStep(
	steps: WebStep[],
	messageId: string,
	part: "thinking" | "text",
	content: string,
	now: number,
): void {
	const last = steps.at(-1);
	if (part === "thinking") {
		if (last?.kind === "thinking" && !last.complete) {
			last.text += content;
			return;
		}
		closeOpenContentSteps(steps, now);
		steps.push({
			kind: "thinking",
			id: stepId(messageId, "thinking", steps.length),
			text: content,
			startedAt: now,
		});
		return;
	}
	if (last?.kind === "text" && !last.complete) {
		last.text += content;
		return;
	}
	closeOpenContentSteps(steps, now);
	steps.push({ kind: "text", id: stepId(messageId, "text", steps.length), text: content });
}

export function upsertToolStep(steps: WebStep[], tool: WebToolEvent, now: number): void {
	const index = steps.findIndex((step) => step.kind === "tool" && step.tool.id === tool.id);
	if (index >= 0) {
		const existing = steps[index];
		if (existing?.kind === "tool") existing.tool = mergeToolEvent(existing.tool, tool);
		return;
	}
	closeOpenContentSteps(steps, now);
	steps.push({ kind: "tool", id: tool.id, tool });
}

export function applyStoredAgentEventToMessage(
	message: WebMessage,
	record: Extract<ChatLogRecord, { type: "agent_event" }>,
	options: { applyTextDeltas: boolean; applyThinkingDeltas: boolean },
): void {
	const event = record.event;
	const ts = toUnixMs(record.ts);
	message.steps ??= [];
	const steps = message.steps;
	if (event.type === "message_update") {
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type === "text_delta") {
			appendDeltaStep(steps, message.id, "text", assistantEvent.delta, ts);
			if (options.applyTextDeltas) message.text += assistantEvent.delta;
		}
		if (assistantEvent.type === "thinking_delta") {
			appendDeltaStep(steps, message.id, "thinking", assistantEvent.delta, ts);
			if (options.applyThinkingDeltas) message.thinking = `${message.thinking ?? ""}${assistantEvent.delta}`;
		}
	}
	if (event.type === "message_end") {
		closeOpenContentSteps(steps, ts);
		if (event.usage) message.usage = event.usage;
		if (event.errorMessage) {
			steps.push({ kind: "error", id: stepId(message.id, "error", steps.length), text: event.errorMessage });
		}
	}
	const tool = toolFromStoredAgentEvent(event, ts);
	if (tool) {
		upsertToolStep(steps, tool, ts);
		const tools = message.tools ?? [];
		const index = tools.findIndex((candidate) => candidate.id === tool.id);
		if (index >= 0) {
			tools[index] = mergeToolEvent(tools[index], tool);
		} else {
			tools.push(tool);
		}
		message.tools = tools;
	}
}

export function ensureFallbackSteps(message: WebMessage): void {
	if (message.steps?.length) return;
	const steps: WebStep[] = [];
	if (message.thinking || message.thinkingMs != null) {
		const endedAt = message.ts;
		steps.push({
			kind: "thinking",
			id: stepId(message.id, "thinking", steps.length),
			text: message.thinking ?? "",
			startedAt: endedAt - (message.thinkingMs ?? 0),
			endedAt,
			complete: true,
		});
	}
	for (const tool of message.tools ?? []) steps.push({ kind: "tool", id: tool.id, tool });
	if (message.text) {
		steps.push({ kind: "text", id: stepId(message.id, "text", steps.length), text: message.text, complete: true });
	}
	if (steps.length) message.steps = steps;
}

export function webMessagesFromRecords(
	config: Config,
	records: readonly ChatLogRecord[],
	assistantName: string,
): WebMessage[] {
	const hidden = hiddenWebMessageIds(records);
	const messages: WebMessage[] = [];
	const messagesById = new Map<string, WebMessage>();
	const pendingAgentEvents = new Map<string, Extract<ChatLogRecord, { type: "agent_event" }>[]>();
	for (const record of records) {
		const message = webMessageFromRecord(config, record, assistantName);
		if (message && hidden.has(message.id)) continue;
		if (message) {
			messages.push(message);
			messagesById.set(message.id, message);
			const pending = pendingAgentEvents.get(message.id) ?? [];
			for (const pendingRecord of pending) {
				applyStoredAgentEventToMessage(message, pendingRecord, {
					applyTextDeltas: !message.text && !message.silent,
					applyThinkingDeltas: !message.thinking,
				});
			}
			pendingAgentEvents.delete(message.id);
		}
		if (record.type === "agent_event") {
			if (hidden.has(record.messageId)) continue;
			const existing = messagesById.get(record.messageId);
			if (existing) {
				applyStoredAgentEventToMessage(existing, record, {
					applyTextDeltas: !existing.silent,
					applyThinkingDeltas: true,
				});
			} else {
				const pending = pendingAgentEvents.get(record.messageId) ?? [];
				pending.push(record);
				pendingAgentEvents.set(record.messageId, pending);
			}
		}
	}
	for (const message of messages) ensureFallbackSteps(message);
	return messages;
}

export function webHistoryPayload(
	config: Config,
	records: readonly ChatLogRecord[],
	assistantName: string,
	channelKey: string,
	options: { limit: number; before?: string },
): { messages: WebMessage[]; hasMore: boolean; channelKey: string } {
	const hidden = hiddenWebMessageIds(records);
	let end = records.length;
	if (options.before) {
		let cursorIndex: number | undefined;
		for (let index = records.length - 1; index >= 0; index -= 1) {
			const message = webMessageFromRecord(config, records[index], assistantName);
			if (message && hidden.has(message.id)) continue;
			if (message?.id === options.before) {
				cursorIndex = index;
				break;
			}
		}
		end = cursorIndex ?? records.length;
	}

	const pageEntries: { message: WebMessage; recordIndex: number }[] = [];
	let scanIndex = end - 1;
	for (; scanIndex >= 0 && pageEntries.length < options.limit; scanIndex -= 1) {
		const message = webMessageFromRecord(config, records[scanIndex], assistantName);
		if (message && hidden.has(message.id)) continue;
		if (message) pageEntries.push({ message, recordIndex: scanIndex });
	}

	let hasMore = false;
	let eventStart = 0;
	for (; scanIndex >= 0; scanIndex -= 1) {
		const message = webMessageFromRecord(config, records[scanIndex], assistantName);
		if (message && hidden.has(message.id)) continue;
		if (message) {
			hasMore = true;
			eventStart = scanIndex + 1;
			break;
		}
	}

	const messagesById = new Map<string, { message: WebMessage; recordIndex: number }>();
	for (const entry of pageEntries) messagesById.set(entry.message.id, entry);
	for (let index = eventStart; index < end; index += 1) {
		const record = records[index];
		if (record.type !== "agent_event") continue;
		if (hidden.has(record.messageId)) continue;
		const entry = messagesById.get(record.messageId);
		if (!entry) continue;
		applyStoredAgentEventToMessage(entry.message, record, {
			applyTextDeltas:
				index < entry.recordIndex ? !entry.message.text && !entry.message.silent : !entry.message.silent,
			applyThinkingDeltas: index < entry.recordIndex ? !entry.message.thinking : true,
		});
	}

	const page = pageEntries.reverse().map((entry) => {
		ensureFallbackSteps(entry.message);
		return entry.message;
	});
	return { messages: page, hasMore, channelKey };
}

export function webMessageFromRecord(
	config: Config,
	record: ChatLogRecord,
	assistantName: string,
): WebMessage | undefined {
	if (!isUserVisibleRuntimeRecord(record)) return undefined;
	if (record.type === "inbound") {
		return {
			id: record.messageId,
			role: "user",
			who: record.authorName || getContactNickname(WEB_USER_NAME),
			text: record.text,
			attachments: webAttachments(config, record.attachments),
			ts: toUnixMs(record.ts),
		};
	}
	if (record.type === "outbound" && !record.control) {
		return {
			id: record.webMessageId || record.messageIds[0] || `out_${record.recordId}`,
			role: "assistant",
			who: assistantName,
			text: record.text,
			attachments: webAttachments(config, record.attachments),
			thinking: record.thinking,
			thinkingMs: record.thinkingMs,
			silent: record.silent || undefined,
			ts: toUnixMs(record.ts),
		};
	}
	if (record.type === "runtime" || record.type === "error") {
		return {
			id: `sys_${record.recordId}`,
			role: "system",
			who: "system",
			text: record.type === "runtime" ? record.detail || record.event : record.message,
			ts: toUnixMs(record.ts),
		};
	}
	return undefined;
}
