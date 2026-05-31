import type { AgentEvent } from "@earendil-works/pi-agent-core";

import type { FamiliarAgent, FamiliarAgentReply } from "./agent.js";
import { createAgentWorkQueue } from "./agent-work-queue.js";
import type { ChatChannelRef, StoredAttachment } from "./chat-log.js";
import type { Config } from "./config.js";
import type { DiscordChatChannel } from "./discord/channel.js";
import type { MemoryService } from "./memory/service.js";
import type { ConversationRuntime } from "./runtime.js";
import { createRuntimeManager } from "./runtime-manager.js";
import { createSchedulerRunner, type SchedulerDeliverySink } from "./scheduler-runner.js";

export interface DiscordWebSession {
	key: string;
	label: string;
	channel: ChatChannelRef;
	isDefault?: boolean;
}

interface AgentCoreDiscordBindings {
	botUserId: string;
	resolveDefaultSession: () => Promise<{ runtime: ConversationRuntime; channel: DiscordChatChannel }>;
	delivery: SchedulerDeliverySink<DiscordChatChannel>;
	getWebSessions(): Promise<DiscordWebSession[]>;
}

export interface AgentCore {
	attachDiscord(bindings: AgentCoreDiscordBindings): void;
	getRuntimeForChannel(channel: ChatChannelRef): Promise<ConversationRuntime>;
	peekRuntime(channelKey: string): Promise<ConversationRuntime | undefined>;
	getWebSessions(): Promise<DiscordWebSession[]>;
	getRuntimeForWebChannel(channelKey?: string): Promise<ConversationRuntime>;
	promptForRuntime(
		runtime: ConversationRuntime,
		jobId: string,
		prompt: string,
		attachments?: StoredAttachment[],
		onEvent?: (event: AgentEvent) => void | Promise<void>,
		onTurnEnd?: () => void | Promise<void>,
	): Promise<FamiliarAgentReply>;
	readonly activeOwner: string | undefined;
	startScheduler(): Promise<void>;
	rearmHeartbeat(): void;
	stopScheduler(): void;
	disconnectAll(): Promise<void>;
}

export function createAgentCore(deps: {
	config: Config;
	familiarAgent: FamiliarAgent;
	memoryService?: MemoryService;
}): AgentCore {
	let discordBindings: AgentCoreDiscordBindings | undefined;
	const requireDiscordBindings = (): AgentCoreDiscordBindings => {
		if (!discordBindings) throw new Error("Discord bindings are not attached");
		return discordBindings;
	};
	const runtimeManager = createRuntimeManager({
		config: deps.config,
		memoryService: deps.memoryService,
		botUserId: () => requireDiscordBindings().botUserId,
	});
	const agentWork = createAgentWorkQueue({ familiarAgent: deps.familiarAgent });
	const scheduler = createSchedulerRunner({
		config: deps.config,
		agentWork,
		familiarAgent: deps.familiarAgent,
		resolveDefaultSession: () => requireDiscordBindings().resolveDefaultSession(),
		delivery: {
			deliver: (options) => requireDiscordBindings().delivery.deliver(options),
		},
	});

	return {
		attachDiscord(bindings: AgentCoreDiscordBindings): void {
			discordBindings = bindings;
		},
		getRuntimeForChannel: runtimeManager.getRuntimeForChannel,
		peekRuntime: runtimeManager.peekRuntime,
		getWebSessions(): Promise<DiscordWebSession[]> {
			return requireDiscordBindings().getWebSessions();
		},
		async getRuntimeForWebChannel(channelKey?: string): Promise<ConversationRuntime> {
			const sessions = await requireDiscordBindings().getWebSessions();
			const session = channelKey ? sessions.find((candidate) => candidate.key === channelKey) : sessions[0];
			if (!session) throw new Error(channelKey ? `Unknown web session: ${channelKey}` : "No sessions available");
			return runtimeManager.getRuntimeForChannel(session.channel);
		},
		promptForRuntime: agentWork.promptForRuntime,
		get activeOwner(): string | undefined {
			return agentWork.activeOwner;
		},
		startScheduler: scheduler.start,
		rearmHeartbeat: scheduler.rearmHeartbeat,
		stopScheduler: scheduler.stop,
		disconnectAll: runtimeManager.disconnectAll,
	};
}
