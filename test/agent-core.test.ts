import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChatChannelRef, ChatService } from "../src/conversation/chat-log.js";
import { createAgentCore, WEB_OWNER_ID, type PlatformSource } from "../src/runtime/agent-core.js";
import type { FamiliarAgent } from "../src/agent/factory.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

const fakeAgent = {} as FamiliarAgent;

function source(service: ChatService, ownerId: string, channelId: string, botUserId?: string): PlatformSource {
	const channel: ChatChannelRef = { service, scope: "channel", channelId };
	return {
		service,
		ownerId,
		botUserId,
		resolveDefaultSession: async () => ({ runtime: await Promise.reject(new Error("unused")) }),
		getWebSessions: async () => [{ key: `${service}:channel:${channelId}`, label: service, channel }],
		delivery: { deliver: async () => [] },
	};
}

const mainChat = {
	key: "web-web-main",
	label: "Main Chat",
	channel: { service: "web", scope: "web", channelId: "main" },
	isDefault: true,
};

describe("agent core platform sources", () => {
	it("uses the Web fallback when nothing is attached", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const core = createAgentCore({ config, familiarAgent: fakeAgent });
		t.after(() => core.stop());
		assert.deepEqual(await core.getWebSessions(), [mainChat]);
		const runtime = await core.getRuntimeForWebChannel();
		assert.equal(runtime.ownerId, WEB_OWNER_ID);
	});

	it("keeps Main Chat first and lists platform channels after it", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const core = createAgentCore({ config, familiarAgent: fakeAgent });
		t.after(() => core.stop());
		await core.attachPlatform(source("qq", "qq-owner", "q", "qq-bot"));
		await core.attachPlatform(source("discord", "dc-owner", "d", "dc-bot"));
		// Main Chat is the shared owner DM: always present, always default, regardless of default_platform.
		assert.deepEqual(
			(await core.getWebSessions()).map(({ key, isDefault }) => ({ key, isDefault })),
			[
				{ key: "web-web-main", isDefault: true },
				{ key: "discord:channel:d", isDefault: undefined },
				{ key: "qq:channel:q", isDefault: undefined },
			],
		);
		config.defaultPlatform = "qq";
		assert.equal((await core.getWebSessions())[0]?.key, "web-web-main");
		assert.equal((await core.getRuntimeForChannel({ service: "qq", scope: "channel", channelId: "q" })).ownerId, "qq-owner");
		assert.equal(
			(await core.getRuntimeForChannel({ service: "discord", scope: "channel", channelId: "d" })).ownerId,
			"dc-owner",
		);
	});

	it("replaces a source for the same service and rejects unattached services", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const core = createAgentCore({ config, familiarAgent: fakeAgent });
		t.after(() => core.stop());
		await core.attachPlatform(source("discord", "old", "old"));
		await core.attachPlatform(source("discord", "new", "new"));
		assert.equal(
			(await core.getRuntimeForChannel({ service: "discord", scope: "channel", channelId: "new" })).ownerId,
			"new",
		);
		await assert.rejects(
			() => core.getRuntimeForChannel({ service: "qq", scope: "channel", channelId: "q" }),
			/No platform source attached/,
		);
	});
});
