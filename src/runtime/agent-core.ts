import type { AgentEvent } from "@earendil-works/pi-agent-core";

import type { FamiliarAgent, FamiliarAgentReply } from "../agent/factory.js";
import type { Config } from "../config/index.js";
import {
	type ChatChannelRef,
	type ChatService,
	chatChannelKey,
	type StoredAttachment,
} from "../conversation/chat-log.js";
import type { OwnerIdentity } from "../conversation/owner-identity.js";
import type { MemoryService } from "../memory/service.js";
import { createAgentWorkQueue } from "./agent-work-queue.js";
import type { ConversationRuntime } from "./conversation-runtime.js";
import { createRuntimeManager } from "./runtime-manager.js";
import { createSchedulerRunner, type SchedulerDeliverySink } from "./scheduler-runner.js";

export const WEB_OWNER_ID = "owner";

export interface ChatSession {
	key: string;
	label: string;
	channel: ChatChannelRef;
	isDefault?: boolean;
}

export interface PlatformSource {
	service: ChatService;
	ownerId: string;
	botUserId?: string;
	resolveDefaultSession: () => Promise<{ runtime: ConversationRuntime }>;
	getWebSessions(): Promise<ChatSession[]>;
	delivery: SchedulerDeliverySink;
}

// The owner's DM is one conversation regardless of which platform it arrives on:
// Discord DMs, QQ private messages, and the WebUI all resolve to this single ref,
// so the companion keeps one continuous thread with its owner across devices.
// Group channels stay per-platform — those are genuinely separate rooms.
export const ownerDmRef: ChatChannelRef = { service: "web", scope: "web", channelId: "main" };
const webPersistenceOnlyDelivery: SchedulerDeliverySink = {
	async deliver() {
		return [];
	},
};

export interface AgentCore {
	attachPlatform(source: PlatformSource): Promise<void>;
	useCachedIdentity(identity: OwnerIdentity): Promise<void>;
	start(): Promise<void>;
	getRuntimeForChannel(channel: ChatChannelRef): Promise<ConversationRuntime>;
	peekRuntime(channelKey: string): Promise<ConversationRuntime | undefined>;
	getWebSessions(): Promise<ChatSession[]>;
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
	const sources = new Map<ChatService, PlatformSource>();
	const webSource: PlatformSource = {
		service: "web",
		ownerId: WEB_OWNER_ID,
		resolveDefaultSession: async () => ({ runtime: await runtimeManager.getRuntimeForChannel(ownerDmRef) }),
		getWebSessions: async () => [],
		delivery: webPersistenceOnlyDelivery,
	};
	sources.set("web", webSource);
	const priority: ChatService[] = ["discord", "qq", "web"];
	// Resolve this on each scheduler call so a later live attachment takes over immediately.
	const primary = (): PlatformSource =>
		(deps.config.defaultPlatform && sources.get(deps.config.defaultPlatform)) ||
		priority.map((service) => sources.get(service)).find((source): source is PlatformSource => source !== undefined)!;
	const runtimeManager = createRuntimeManager({
		config: deps.config,
		memoryService: deps.memoryService,
		identityFor: (channel) => {
			const source = sources.get(channel.service);
			if (!source) throw new Error(`No platform source attached for service: ${channel.service}`);
			return { ownerId: source.ownerId, botUserId: source.botUserId };
		},
	});
	const agentWork = createAgentWorkQueue({ familiarAgent: deps.familiarAgent });
	const scheduler = createSchedulerRunner({
		config: deps.config,
		agentWork,
		familiarAgent: deps.familiarAgent,
		resolveDefaultSession: () => primary().resolveDefaultSession(),
		delivery: { deliver: (options) => primary().delivery.deliver(options) },
	});
	let schedulerStarted = false;

	return {
		async attachPlatform(source): Promise<void> {
			sources.set(source.service, source);
		},
		async useCachedIdentity(identity): Promise<void> {
			const ownerId = deps.config.discord.ownerId;
			if (!ownerId) throw new Error("Cached Discord identity requires discord.owner_id");
			await this.attachPlatform({
				service: "discord",
				ownerId,
				botUserId: identity.botUserId,
				resolveDefaultSession: async () => ({ runtime: await runtimeManager.getRuntimeForChannel(ownerDmRef) }),
				getWebSessions: async () => [],
				delivery: webPersistenceOnlyDelivery,
			});
		},
		async start(): Promise<void> {
			if (schedulerStarted) return;
			schedulerStarted = true;
			await scheduler.start();
		},
		getRuntimeForChannel: runtimeManager.getRuntimeForChannel,
		peekRuntime: runtimeManager.peekRuntime,
		async getWebSessions(): Promise<ChatSession[]> {
			// Main Chat is the owner DM shared by every platform, so it always leads the list.
			const sessions: ChatSession[] = [
				{ key: chatChannelKey(ownerDmRef), label: "Main Chat", channel: ownerDmRef, isDefault: true },
			];
			for (const service of priority) {
				const source = sources.get(service);
				if (!source) continue;
				for (const session of await source.getWebSessions()) {
					const { isDefault: _isDefault, ...withoutDefault } = session;
					sessions.push(withoutDefault);
				}
			}
			return sessions;
		},
		async getRuntimeForWebChannel(channelKey?: string): Promise<ConversationRuntime> {
			const sessions = await this.getWebSessions();
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
