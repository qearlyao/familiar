import { startDiscordDaemon } from "./discord/daemon.js";
import { startQqDaemon } from "./qq/daemon.js";
import type { ChannelDefinition } from "./runtime/channel.js";
import { startWebDaemon } from "./web/daemon.js";

/** every chat surface, started in this order; the WebUI always runs */
export const CHANNELS: readonly ChannelDefinition[] = [
	{ name: "web", enabled: () => true, start: startWebDaemon },
	{
		name: "discord",
		enabled: (config) => config.discord.enabled && !!config.discord.token,
		start: startDiscordDaemon,
	},
	{ name: "qq", enabled: (config) => config.qq.enabled && !!config.qq.wsUrl, start: startQqDaemon },
];
