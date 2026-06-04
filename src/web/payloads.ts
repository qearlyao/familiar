import type { FamiliarAgent } from "../agent/factory.js";
import { supportedThinkingLevels } from "../models/index.js";
import type { DiscordWebSession } from "../runtime/agent-core.js";
import { isRecord } from "../util/guards.js";

export function commandArgs(command: string, args: unknown): string {
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

export function sessionDto(session: DiscordWebSession): Record<string, unknown> {
	return {
		key: session.key,
		label: session.label,
		service: session.channel.service,
		scope: session.channel.scope,
		channelId: session.channel.channelId,
		channelName: session.channel.channelName,
		threadId: session.channel.threadId,
		isDefault: session.isDefault,
	};
}
