import type { FamiliarAgent } from "../agent.js";
import type { DiscordWebSession } from "../discord.js";
import { supportedThinkingLevels } from "../models.js";
import type { EffectiveSetting } from "../settings.js";
import { isObject } from "../web-http.js";

export function commandArgs(command: string, args: unknown): string {
	if (!isObject(args)) return "";
	if (command === "model") return typeof args.model === "string" ? args.model : "";
	if (command === "thinking") return typeof args.level === "string" ? args.level : "";
	if (command === "channel-trigger") return typeof args.trigger === "string" ? args.trigger : "";
	return "";
}

export function formatSetting<T>(setting: EffectiveSetting<T>): string {
	return `${setting.value} (${setting.source})`;
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
