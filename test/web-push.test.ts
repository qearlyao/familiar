import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import webpush, { type PushSubscription } from "web-push";

import { createPushService } from "../src/web/push.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

function subscription(endpoint: string): PushSubscription {
	return { endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } };
}

test("push service persists VAPID keys across restarts", async (t) => {
	const dataDir = await createTempDataDir(t);
	const config = await configWithDataDir(t, dataDir);
	const first = await createPushService(config);
	const second = await createPushService(config);
	assert.equal(second.publicKey, first.publicKey);
});

test("push service persists subscriptions and unsubscribe removes them", async (t) => {
	const dataDir = await createTempDataDir(t);
	const config = await configWithDataDir(t, dataDir);
	const push = await createPushService(config);
	await push.subscribe(subscription("https://push.example/one"), "phone");
	await push.subscribe(subscription("https://push.example/one"), "phone");
	await push.subscribe(subscription("https://push.example/two"));

	const path = resolve(dataDir, "settings", "web-push.json");
	let stored = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(
		stored.subscriptions.map((entry: { subscription: PushSubscription }) => entry.subscription.endpoint),
		["https://push.example/one", "https://push.example/two"],
	);

	await push.unsubscribe("https://push.example/one");
	stored = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(
		stored.subscriptions.map((entry: { subscription: PushSubscription }) => entry.subscription.endpoint),
		["https://push.example/two"],
	);
});

test("notify sends to every subscription and prunes gone endpoints", async (t) => {
	const dataDir = await createTempDataDir(t);
	const config = await configWithDataDir(t, dataDir);
	const push = await createPushService(config);
	await push.subscribe(subscription("https://push.example/live"));
	await push.subscribe(subscription("https://push.example/gone"));

	const sent: string[] = [];
	const originalSend = webpush.sendNotification;
	webpush.sendNotification = (async (target: PushSubscription, payload?: unknown) => {
		sent.push(`${target.endpoint}:${payload}`);
		if (target.endpoint.endsWith("/gone")) {
			throw Object.assign(new Error("gone"), { statusCode: 410 });
		}
		return { statusCode: 201, body: "", headers: {} };
	}) as typeof webpush.sendNotification;
	t.after(() => {
		webpush.sendNotification = originalSend;
	});

	await push.notify({ title: "familiar", body: "hello" });
	assert.equal(sent.length, 2);
	assert.ok(sent.every((entry) => entry.includes('"body":"hello"')));

	const stored = JSON.parse(await readFile(resolve(dataDir, "settings", "web-push.json"), "utf8"));
	assert.deepEqual(
		stored.subscriptions.map((entry: { subscription: PushSubscription }) => entry.subscription.endpoint),
		["https://push.example/live"],
	);
});
