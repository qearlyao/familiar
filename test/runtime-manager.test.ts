import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChatChannelRef } from "../src/conversation/chat-log.js";
import type { MemoryService } from "../src/memory/service.js";
import { createRuntimeManager } from "../src/runtime/runtime-manager.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

function spyMemoryService(): {
	memory: MemoryService;
	subscribeCalls: string[];
	unsubscribeCalls: string[];
} {
	const subscribeCalls: string[] = [];
	const unsubscribeCalls: string[] = [];
	const memory: MemoryService = {
		memoryTools: () => [],
		indexDiaries: async () => {},
		watchDiaries: () => {},
		subscribeRuntime: (runtime) => {
			subscribeCalls.push(runtime.channelKey);
			return () => {
				unsubscribeCalls.push(runtime.channelKey);
			};
		},
		transformContext: async (messages) => messages,
		serviceCompactionDebt: async () => {},
		flush: async () => {},
		close: () => {},
	};
	return { memory, subscribeCalls, unsubscribeCalls };
}

describe("runtime manager lifecycle", () => {
	it("releases the memory subscription when a runtime is disconnected", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const { memory, subscribeCalls, unsubscribeCalls } = spyMemoryService();
		const manager = createRuntimeManager({ config, memoryService: memory, botUserId: () => "bot-1" });
		t.after(() => manager.disconnectAll());

		const dmRef: ChatChannelRef = { service: "discord", scope: "dm", channelId: "dm-123" };
		await manager.getRuntimeForChannel(dmRef);
		assert.deepEqual(subscribeCalls, ["discord-dm-dm-123"]);
		assert.deepEqual(unsubscribeCalls, []);

		await manager.disconnectAll();
		assert.deepEqual(unsubscribeCalls, ["discord-dm-dm-123"]);

		// A fresh request re-opens the runtime (and re-subscribes), proving disconnectAll
		// dropped the entry and released its chat-log lock rather than orphaning it.
		await manager.getRuntimeForChannel(dmRef);
		assert.deepEqual(subscribeCalls, ["discord-dm-dm-123", "discord-dm-dm-123"]);
	});
});
