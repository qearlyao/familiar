import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FamiliarAgent } from "../agent/factory.js";
import type { Config } from "../config/index.js";
import type { SettingsStore } from "../config/settings.js";
import type { RestartHandler } from "../lifecycle/control.js";
import type { AgentCore } from "./agent-core.js";

/** what every chat surface is started with */
export interface ChannelContext {
	config: Config;
	familiarAgent: FamiliarAgent;
	settings: SettingsStore;
	core: AgentCore;
	modelRuntime: ModelRuntime;
	restart: RestartHandler;
}

export interface Channel {
	stop(): Promise<void>;
}

/** a chat surface the daemon runs when its config turns it on */
export interface ChannelDefinition {
	name: string;
	enabled(config: Config): boolean;
	start(ctx: ChannelContext): Channel | Promise<Channel>;
}
