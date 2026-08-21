import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { createWebPushService } from "../src/web/push.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

const subscription = (endpoint: string) => ({
	endpoint,
	keys: { p256dh: "p256dh-key", auth: "auth-key" },
});

describe("web push service", () => {
	it("persists vapid keys and subscriptions across reloads", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);

		const service = await createWebPushService(config);
		const key = service.publicKey();
		assert.ok(key.length > 0);

		await service.subscribe(subscription("https://push.example/a"));
		await service.subscribe(subscription("https://push.example/b"));
		assert.equal(service.subscriptionCount(), 2);

		// Re-subscribing the same endpoint replaces, not duplicates.
		await service.subscribe(subscription("https://push.example/a"));
		assert.equal(service.subscriptionCount(), 2);

		await service.unsubscribe("https://push.example/a");
		assert.equal(service.subscriptionCount(), 1);

		const reloaded = await createWebPushService(config);
		assert.equal(reloaded.publicKey(), key);
		assert.equal(reloaded.subscriptionCount(), 1);
	});

	it("regenerates keys when the store file is unreadable", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		await mkdir(resolve(dataDir, "settings"), { recursive: true });
		await writeFile(resolve(dataDir, "settings", "web-push.json"), "not json", "utf8");

		const service = await createWebPushService(config);
		assert.ok(service.publicKey().length > 0);
		assert.equal(service.subscriptionCount(), 0);
	});
});
