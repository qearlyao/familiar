import type { AgentEvent } from "@earendil-works/pi-agent-core";

import type { StoredAgentEvent, StoredAssistantMessageEvent } from "../conversation/chat-log.js";
import { isRecord } from "../util/guards.js";

export interface AgentEventSummary {
	thinking: string;
	thinkingStart?: number;
	thinkingEnd?: number;
}

type AgentEventWriter = (event: StoredAgentEvent) => Promise<void>;

export interface AgentEventRecorder {
	record(event: StoredAgentEvent): Promise<void>;
	flush(): Promise<void>;
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function deltaKind(event: StoredAgentEvent): "text_delta" | "thinking_delta" | undefined {
	if (event.type !== "message_update") return undefined;
	const assistantEvent = event.assistantMessageEvent;
	return assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta"
		? assistantEvent.type
		: undefined;
}

function deltaText(event: StoredAgentEvent): string {
	if (event.type !== "message_update") return "";
	const assistantEvent = event.assistantMessageEvent;
	return assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta" ? assistantEvent.delta : "";
}

function deltaEvent(kind: "text_delta" | "thinking_delta", delta: string): StoredAgentEvent {
	return { type: "message_update", assistantMessageEvent: { type: kind, delta } };
}

export function createAgentEventRecorder(write: AgentEventWriter): AgentEventRecorder {
	let pendingKind: "text_delta" | "thinking_delta" | undefined;
	let pendingDelta = "";

	const flush = async (): Promise<void> => {
		if (!pendingKind || !pendingDelta) {
			pendingKind = undefined;
			pendingDelta = "";
			return;
		}
		const kind = pendingKind;
		const delta = pendingDelta;
		pendingKind = undefined;
		pendingDelta = "";
		const event = deltaEvent(kind, delta);
		await write(event);
	};

	return {
		async record(event: StoredAgentEvent): Promise<void> {
			const kind = deltaKind(event);
			if (kind) {
				if (pendingKind === kind) {
					pendingDelta += deltaText(event);
					return;
				}
				await flush();
				pendingKind = kind;
				pendingDelta = deltaText(event);
				return;
			}
			await flush();
			await write(event);
		},
		flush,
	};
}

function usageFromAgentEvent(event: AgentEvent): Extract<StoredAgentEvent, { type: "message_end" }>["usage"] {
	if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
	const usage = event.message.usage;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cost: usage.cost.total,
	};
}

function storedAssistantMessageEvent(event: AgentEvent): StoredAssistantMessageEvent | undefined {
	if (event.type !== "message_update") return undefined;
	const assistantEvent = event.assistantMessageEvent;
	if (assistantEvent.type === "text_delta") {
		return { type: "text_delta", delta: assistantEvent.delta };
	}
	if (assistantEvent.type === "thinking_delta") {
		return { type: "thinking_delta", delta: assistantEvent.delta };
	}
	if (assistantEvent.type === "toolcall_start") {
		return { type: "toolcall_start", contentIndex: assistantEvent.contentIndex };
	}
	if (assistantEvent.type === "toolcall_delta") {
		return {
			type: "toolcall_delta",
			contentIndex: assistantEvent.contentIndex,
			delta: assistantEvent.delta,
		};
	}
	if (assistantEvent.type === "toolcall_end") {
		return {
			type: "toolcall_end",
			contentIndex: assistantEvent.contentIndex,
			toolCall: {
				id: assistantEvent.toolCall.id,
				name: assistantEvent.toolCall.name,
				arguments: normalizeToolArguments(assistantEvent.toolCall.arguments),
			},
		};
	}
	return undefined;
}

export function storedAgentEventFromAgentEvent(event: AgentEvent): StoredAgentEvent | undefined {
	if (event.type === "agent_start" || event.type === "agent_end") return { type: event.type };
	if (event.type === "turn_start" || event.type === "turn_end") return { type: event.type };
	if (event.type === "message_start") {
		return { type: "message_start", role: event.message.role };
	}
	if (event.type === "message_update") {
		const assistantMessageEvent = storedAssistantMessageEvent(event);
		return assistantMessageEvent ? { type: "message_update", assistantMessageEvent } : undefined;
	}
	if (event.type === "message_end") {
		return {
			type: "message_end",
			role: event.message.role,
			stopReason: event.message.role === "assistant" ? event.message.stopReason : undefined,
			errorMessage: event.message.role === "assistant" ? event.message.errorMessage : undefined,
			usage: usageFromAgentEvent(event),
		};
	}
	if (event.type === "tool_execution_start") {
		return {
			type: "tool_execution_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		};
	}
	if (event.type === "tool_execution_update") {
		return {
			type: "tool_execution_update",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			partialResult: event.partialResult,
		};
	}
	return {
		type: "tool_execution_end",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		result: event.result,
		isError: event.isError,
	};
}

export function updateAgentEventSummary(summary: AgentEventSummary, event: AgentEvent, now = Date.now()): void {
	if (event.type !== "message_update") return;
	const assistantEvent = event.assistantMessageEvent;
	if (assistantEvent.type === "thinking_delta") {
		summary.thinkingStart ??= now;
		summary.thinkingEnd = now;
		summary.thinking += assistantEvent.delta;
	}
	if (assistantEvent.type === "thinking_end") {
		summary.thinkingEnd = now;
	}
}

export function thinkingDurationMs(summary: AgentEventSummary): number | undefined {
	if (summary.thinkingStart === undefined) return undefined;
	return Math.max(0, (summary.thinkingEnd ?? Date.now()) - summary.thinkingStart);
}
