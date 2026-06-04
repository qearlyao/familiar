import { type ChatChannelRef, chatChannelKey, createChatLog } from "../chat-log.js";
import type { Config } from "../config.js";
import type { MemoryService } from "../memory/service.js";
import { ConversationRuntime } from "./conversation-runtime.js";

export interface RuntimeManagerDeps {
	config: Config;
	memoryService?: MemoryService;
	botUserId: () => string;
}

// A runtime owns two external resources: the chat-log `.lock` (released by
// runtime.disconnect()) and the memory projection subscription (released by the
// handle subscribeRuntime returns). They are acquired together and must be torn
// down together — on connect rollback, on disconnectAll, and on any future eviction.
interface RuntimeEntry {
	runtime: ConversationRuntime;
	release(): Promise<void>;
}

export function createRuntimeManager(deps: RuntimeManagerDeps) {
	const runtimes = new Map<string, Promise<RuntimeEntry>>();

	const openEntry = async (channel: ChatChannelRef, channelKey: string): Promise<RuntimeEntry> => {
		const runtime = await ConversationRuntime.connect({
			channelKey,
			log: createChatLog(deps.config, channel),
			ownerId: deps.config.discord.ownerId,
			botUserId: deps.botUserId(),
		});
		const unsubscribe = deps.memoryService?.subscribeRuntime(runtime, runtime.channelKey);
		const release = async (): Promise<void> => {
			unsubscribe?.();
			await runtime.disconnect();
		};
		try {
			await runtime.armAfterCurrentTail();
		} catch (error) {
			await release();
			throw error;
		}
		return { runtime, release };
	};

	return {
		async getRuntimeForChannel(channel: ChatChannelRef): Promise<ConversationRuntime> {
			const channelKey = chatChannelKey(channel);
			const existing = runtimes.get(channelKey);
			if (existing) return (await existing).runtime;
			const entryPromise = openEntry(channel, channelKey);
			runtimes.set(channelKey, entryPromise);
			try {
				return (await entryPromise).runtime;
			} catch (error) {
				runtimes.delete(channelKey);
				throw error;
			}
		},

		async peekRuntime(channelKey: string): Promise<ConversationRuntime | undefined> {
			return (await runtimes.get(channelKey)?.catch(() => undefined))?.runtime;
		},

		async disconnectAll(): Promise<void> {
			const entries = await Promise.all([...runtimes.values()].map((entry) => entry.catch(() => undefined)));
			runtimes.clear();
			await Promise.all(entries.flatMap((entry) => (entry ? [entry.release()] : [])));
		},
	};
}
