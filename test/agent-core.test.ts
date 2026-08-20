import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChatChannelRef, ChatService } from "../src/conversation/chat-log.js";
import { createAgentCore, WEB_OWNER_ID, type PlatformSource } from "../src/runtime/agent-core.js";
import type { FamiliarAgent } from "../src/agent/factory.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

const fakeAgent = {} as FamiliarAgent;

function source(service: ChatService, ownerId: string, channelId: string, botUserId?: string): PlatformSource {
	const channel: ChatChannelRef = { service, scope: service === "web" ? "web" : "dm", channelId };
	return {
		service,
		ownerId,
		botUserId,
		resolveDefaultSession: async () => ({ runtime: await Promise.reject(new Error("unused")) }),
		getWebSessions: async () => [{ key: `${service}:dm:${channelId}`, label: service, channel, isDefault: true }],
		delivery: { deliver: async () => [] },
	};
}

describe("agent core platform sources", () => {
	it("uses the Web fallback when nothing is attached", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const core = createAgentCore({ config, familiarAgent: fakeAgent });
		t.after(() => core.stop());
		assert.deepEqual(await core.getWebSessions(), [
			{ key: "web-web-main", label: "Main Chat", channel: { service: "web", scope: "web", channelId: "main" }, isDefault: true },
		]);
		const runtime = await core.getRuntimeForWebChannel();
		assert.equal(runtime.ownerId, WEB_OWNER_ID);
	});

	it("orders sources and honors default_platform", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const core = createAgentCore({ config, familiarAgent: fakeAgent });
		t.after(() => core.stop());
		await core.attachPlatform(source("qq", "qq-owner", "q", "qq-bot"));
		await core.attachPlatform(source("discord", "dc-owner", "d", "dc-bot"));
		let sessions = await core.getWebSessions();
		assert.deepEqual(sessions.map(({ key, isDefault }) => ({ key, isDefault })), [
			{ key: "discord:dm:d", isDefault: true },
			{ key: "qq:dm:q", isDefault: undefined },
		]);
		config.defaultPlatform = "qq";
		sessions = await core.getWebSessions();
		assert.deepEqual(sessions.map(({ key, isDefault }) => ({ key, isDefault })), [
			{ key: "discord:dm:d", isDefault: undefined },
			{ key: "qq:dm:q", isDefault: true },
		]);
		assert.equal((await core.getRuntimeForChannel({ service: "qq", scope: "dm", channelId: "q" })).ownerId, "qq-owner");
		assert.equal((await core.getRuntimeForChannel({ service: "discord", scope: "dm", channelId: "d" })).ownerId, "dc-owner");
	});

	it("replaces a source for the same service and rejects unattached services", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const core = createAgentCore({ config, familiarAgent: fakeAgent });
		t.after(() => core.stop());
		await core.attachPlatform(source("discord", "old", "old"));
		await core.attachPlatform(source("discord", "new", "new"));
		assert.equal((await core.getRuntimeForChannel({ service: "discord", scope: "dm", channelId: "new" })).ownerId, "new");
		await assert.rejects(() => core.getRuntimeForChannel({ service: "qq", scope: "dm", channelId: "q" }), /No platform source attached/);
	});
});
