import { type ChatChannelRef, chatChannelKey, createChatLog } from "./chat-log.js";
import type { Config } from "./config.js";
import type { MemoryService } from "./memory/service.js";
import { ConversationRuntime } from "./runtime.js";

export interface RuntimeManagerDeps {
	config: Config;
	memoryService?: MemoryService;
	botUserId: () => string;
}

export function createRuntimeManager(deps: RuntimeManagerDeps) {
	const runtimes = new Map<string, Promise<ConversationRuntime>>();

	return {
		async getRuntimeForChannel(channel: ChatChannelRef): Promise<ConversationRuntime> {
			const channelKey = chatChannelKey(channel);
			const existing = runtimes.get(channelKey);
			if (existing) return existing;
			const runtimePromise = ConversationRuntime.connect({
				channelKey,
				log: createChatLog(deps.config, channel),
				ownerId: deps.config.discord.ownerId,
				botUserId: deps.botUserId(),
			}).then(async (runtime) => {
				deps.memoryService?.subscribeRuntime(runtime, runtime.channelKey);
				await runtime.armAfterCurrentTail();
				return runtime;
			});
			runtimes.set(channelKey, runtimePromise);
			try {
				return await runtimePromise;
			} catch (error) {
				runtimes.delete(channelKey);
				throw error;
			}
		},

		async peekRuntime(channelKey: string): Promise<ConversationRuntime | undefined> {
			return await runtimes.get(channelKey)?.catch(() => undefined);
		},

		async disconnectAll(): Promise<void> {
			const resolvedRuntimes = await Promise.all(
				[...runtimes.values()].map((runtime) => runtime.catch(() => undefined)),
			);
			await Promise.all(resolvedRuntimes.flatMap((runtime) => (runtime ? [runtime.disconnect()] : [])));
		},
	};
}
