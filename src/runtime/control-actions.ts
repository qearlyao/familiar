import type { FamiliarAgent } from "../agent/factory.js";
import type { Config } from "../config/index.js";
import { type EffectiveSetting, formatSetting, type SettingsStore } from "../config/settings.js";
import type { RestartHandler } from "../lifecycle/control.js";
import type { ConversationRuntime } from "./conversation-runtime.js";

export function formatCommandResponse(
	command: "status" | "compact",
	runtime: ConversationRuntime,
	familiarAgent: FamiliarAgent,
	channelTrigger: EffectiveSetting<Config["discord"]["channelTrigger"]>,
): string {
	if (command === "status") {
		return [
			runtime.formatStatus(),
			`model: ${formatSetting(familiarAgent.getModel(runtime.channelKey))}`,
			`thinking: ${formatSetting(familiarAgent.getThinkingLevel(runtime.channelKey))}`,
			`channel_trigger: ${formatSetting(channelTrigger)}`,
		].join("\n");
	}
	return "Compact is not wired for this runtime yet. I logged the command, but I won't run lossy compaction here.";
}

export async function applyControlCommand(options: {
	control: NonNullable<ReturnType<ConversationRuntime["parseControlCommand"]>>;
	runtime: ConversationRuntime;
	familiarAgent: FamiliarAgent;
	settings: SettingsStore;
	channelTrigger: EffectiveSetting<Config["discord"]["channelTrigger"]>;
	isDm: boolean;
	activeAgentOwner: string | undefined;
	restart?: RestartHandler;
}): Promise<string> {
	const { control, runtime, familiarAgent, settings, channelTrigger, isDm, activeAgentOwner, restart } = options;
	if (control.command === "stop") {
		if (runtime.hasActiveJob() && activeAgentOwner === runtime.channelKey) familiarAgent.abort(runtime.channelKey);
		await runtime.resetConversation("stop requested");
		return "Stopped current work and cleared the chat queue.";
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
	if (control.command === "channel-trigger") {
		if (isDm) {
			return "DM channel trigger is always.";
		}
		const triggerInput = control.args.trim().toLowerCase();
		if (triggerInput && triggerInput !== "mention" && triggerInput !== "always") {
			throw new Error("Usage: /channel-trigger mention|always");
		}
		const trigger = triggerInput === "mention" || triggerInput === "always" ? triggerInput : undefined;
		if (trigger) {
			await settings.setChannelTrigger(runtime.channelKey, trigger);
			return `Channel trigger set to ${trigger} for this channel`;
		}
		return `Current channel trigger: ${formatSetting(channelTrigger)}`;
	}
	return formatCommandResponse(control.command, runtime, familiarAgent, channelTrigger);
}
