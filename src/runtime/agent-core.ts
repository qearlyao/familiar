import type { AgentEvent } from "@earendil-works/pi-agent-core";

import type { FamiliarAgent, FamiliarAgentReply } from "../agent.js";
import { type ChatChannelRef, chatChannelKey, type StoredAttachment } from "../chat-log.js";
import type { Config } from "../config.js";
import type { MemoryService } from "../memory/service.js";
import type { OwnerIdentity } from "../owner-identity.js";
import { createAgentWorkQueue } from "./agent-work-queue.js";
import type { ConversationRuntime } from "./conversation-runtime.js";
import { createRuntimeManager } from "./runtime-manager.js";
import { createSchedulerRunner, type SchedulerDeliverySink } from "./scheduler-runner.js";

export interface DiscordWebSession {
	key: string;
	label: string;
	channel: ChatChannelRef;
	isDefault?: boolean;
}

// A session source supplies both how to resolve the default runtime and how to push
// outbound to it. The web-only source (no live Discord) pushes nowhere: outbound is
// still recorded via runtime.noteOutbound and rendered by the WebUI, so the sink just
// returns no message ids.
interface AgentCoreSessionSource {
	botUserId: string;
	resolveDefaultSession: () => Promise<{ runtime: ConversationRuntime }>;
	getWebSessions(): Promise<DiscordWebSession[]>;
	delivery: SchedulerDeliverySink;
}

const webPersistenceOnlyDelivery: SchedulerDeliverySink = {
	async deliver() {
		return [];
	},
};

export interface AgentCore {
	attachDiscord(source: AgentCoreSessionSource): Promise<void>;
	useCachedIdentity(identity: OwnerIdentity): Promise<void>;
	hasSessionSource(): boolean;
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
	rearmHeartbeat(): void;
	stop(): Promise<void>;
}

export function createAgentCore(deps: {
	config: Config;
	familiarAgent: FamiliarAgent;
	memoryService?: MemoryService;
}): AgentCore {
	let sessionSource: AgentCoreSessionSource | undefined;
	const requireSessionSource = (): AgentCoreSessionSource => {
		if (!sessionSource) throw new Error("Owner identity is not established");
		return sessionSource;
	};
	let schedulerStarted = false;
	const runtimeManager = createRuntimeManager({
		config: deps.config,
		memoryService: deps.memoryService,
		botUserId: () => requireSessionSource().botUserId,
	});
	const agentWork = createAgentWorkQueue({ familiarAgent: deps.familiarAgent });
	const scheduler = createSchedulerRunner({
		config: deps.config,
		agentWork,
		familiarAgent: deps.familiarAgent,
		resolveDefaultSession: () => requireSessionSource().resolveDefaultSession(),
		delivery: {
			deliver: (options) => requireSessionSource().delivery.deliver(options),
		},
	});
	// The scheduler can only run once a session source exists; start it with the first
	// source to arrive (cached identity at boot, or the live Discord connection).
	const setSessionSource = async (source: AgentCoreSessionSource): Promise<void> => {
		sessionSource = source;
		if (!schedulerStarted) {
			await scheduler.start();
			schedulerStarted = true;
		}
	};

	return {
		attachDiscord(source: AgentCoreSessionSource): Promise<void> {
			return setSessionSource(source);
		},
		useCachedIdentity(identity: OwnerIdentity): Promise<void> {
			const dmRef: ChatChannelRef = { service: "discord", scope: "dm", channelId: identity.dmChannelId };
			return setSessionSource({
				botUserId: identity.botUserId,
				resolveDefaultSession: async () => ({ runtime: await runtimeManager.getRuntimeForChannel(dmRef) }),
				getWebSessions: async () => [
					{ key: chatChannelKey(dmRef), label: "Main Chat", channel: dmRef, isDefault: true },
				],
				delivery: webPersistenceOnlyDelivery,
			});
		},
		hasSessionSource(): boolean {
			return sessionSource !== undefined;
		},
		getRuntimeForChannel: runtimeManager.getRuntimeForChannel,
		peekRuntime: runtimeManager.peekRuntime,
		getWebSessions(): Promise<DiscordWebSession[]> {
			return requireSessionSource().getWebSessions();
		},
		async getRuntimeForWebChannel(channelKey?: string): Promise<ConversationRuntime> {
			const sessions = await requireSessionSource().getWebSessions();
			const session = channelKey ? sessions.find((candidate) => candidate.key === channelKey) : sessions[0];
			if (!session) throw new Error(channelKey ? `Unknown web session: ${channelKey}` : "No sessions available");
			return runtimeManager.getRuntimeForChannel(session.channel);
		},
		promptForRuntime: agentWork.promptForRuntime,
		get activeOwner(): string | undefined {
			return agentWork.activeOwner;
		},
		rearmHeartbeat: scheduler.rearmHeartbeat,
		stop(): Promise<void> {
			scheduler.stop();
			return runtimeManager.disconnectAll();
		},
	};
}
