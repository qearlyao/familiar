import type { FamiliarAgent } from "../agent/factory.js";
import type { ChatLogRecord } from "../conversation/chat-log.js";
import { supportedThinkingLevels } from "../models/index.js";
import type { ChatSession } from "../runtime/agent-core.js";
import { isRecord } from "../util/guards.js";

export function commandArgs(command: string, args: unknown): string {
	if (typeof args === "string") return args.trim();
	if (!isRecord(args)) return "";
	if (command === "model") return typeof args.model === "string" ? args.model : "";
	if (command === "thinking") return typeof args.level === "string" ? args.level : "";
	if (command === "channel-trigger") return typeof args.trigger === "string" ? args.trigger : "";
	return "";
}

export function agentSettingsPayload(
	familiarAgent: FamiliarAgent,
	channelKey: string,
	personaName: string,
): Record<string, unknown> {
	const { model } = familiarAgent.resolveChannelModel(channelKey);
	return {
		model: familiarAgent.getModel(channelKey),
		thinking: familiarAgent.getThinkingLevel(channelKey),
		supportedThinking: supportedThinkingLevels(model),
		persona: { name: personaName },
	};
}

export function lastContextTokens(records: readonly ChatLogRecord[]): number | undefined {
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i];
		if (record.type !== "agent_event" || record.event.type !== "message_end") continue;
		const usage = record.event.usage;
		if (usage) return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
	}
	return undefined;
}

export function sessionDto(session: ChatSession, context?: { tokens: number; limit: number }): Record<string, unknown> {
	return {
		key: session.key,
		label: session.label,
		service: session.channel.service,
		scope: session.channel.scope,
		channelId: session.channel.channelId,
		channelName: session.channel.channelName,
		threadId: session.channel.threadId,
		isDefault: session.isDefault,
		context,
	};
}
