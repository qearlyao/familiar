import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { describe, it } from "node:test";

import type { FamiliarAgent } from "../src/agent/factory.js";
import { chatChannelKey } from "../src/conversation/chat-log.js";
import { createAgentCore, ownerDmRef, WEB_OWNER_ID } from "../src/runtime/agent-core.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

const fakeAgent = {} as FamiliarAgent;

describe("owner DM sharing", () => {
	it("routes every platform's owner DM into one runtime and one chat log", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const core = createAgentCore({ config, familiarAgent: fakeAgent });
		t.after(() => core.stop());

		// What each daemon does for an owner DM: resolve the shared ref, not its own platform ref.
		const runtime = await core.getRuntimeForChannel(ownerDmRef);
		assert.equal(runtime.ownerId, WEB_OWNER_ID);
		assert.equal(runtime.channelKey, "web-web-main");
		assert.equal(await core.getRuntimeForChannel(ownerDmRef), runtime);
		assert.equal(await core.getRuntimeForWebChannel(), runtime);
		assert.equal(await core.getRuntimeForWebChannel("web-web-main"), runtime);

		const author = { authorId: WEB_OWNER_ID, isBot: false, mentionedBot: true };
		await runtime.ingestInbound({ ...author, messageId: "dc-1", text: "from discord" }, { mode: "queue" });
		await runtime.ingestInbound({ ...author, messageId: "qq-1", text: "from qq" }, { mode: "queue" });
		await runtime.ingestInbound({ ...author, messageId: "web-1", text: "from web" }, { mode: "queue" });

		// One conversation: all three are visible to whichever surface reads next.
		const texts = runtime.getRecords().flatMap((record) => (record.type === "inbound" ? [record.text] : []));
		assert.deepEqual(texts, ["from discord", "from qq", "from web"]);

		// One log directory on disk — no per-platform bifurcation.
		const chatDirs = await readdir(`${dataDir}/chat`);
		assert.deepEqual(chatDirs, [chatChannelKey(ownerDmRef)]);
	});

	it("treats the shared owner DM as a direct conversation", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const core = createAgentCore({ config, familiarAgent: fakeAgent });
		t.after(() => core.stop());

		// isDirect gates steer dispatch and DM triggers. The shared ref carries scope "web",
		// so anything comparing scope to "dm" alone silently drops owner DMs out of steer mode.
		const runtime = await core.getRuntimeForChannel(ownerDmRef);
		assert.equal(runtime.channel.scope, "web");
		assert.equal(runtime.isDirect, true);

		// An owner message in a direct conversation queues a job without needing a mention.
		const { jobQueued } = await runtime.ingestInbound(
			{ authorId: WEB_OWNER_ID, isBot: false, mentionedBot: false, messageId: "m-1", text: "hello" },
			{ mode: "queue" },
		);
		assert.equal(jobQueued, true);
	});
});
