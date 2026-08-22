import { resolve } from "node:path";

import webpush, { type PushSubscription, WebPushError } from "web-push";

import type { Config } from "../config/index.js";
import { atomicWriteJson, createWriteQueue, readFileOrNull } from "../util/fs.js";
import { isRecord } from "../util/guards.js";

interface StoredSubscription extends PushSubscription {
	/** The subscribing page's https origin, used as the VAPID subject for this endpoint. */
	subject?: string;
}

interface PushFile {
	vapid: { publicKey: string; privateKey: string };
	subscriptions: StoredSubscription[];
}

export interface WebPushService {
	publicKey(): string;
	subscriptionCount(): number;
	subscribe(subscription: PushSubscription, subject?: string): Promise<void>;
	unsubscribe(endpoint: string): Promise<void>;
	notify(payload: { title: string; body: string; tag: string }): void;
}

// Fallback for non-https (dev) origins only — APNs rejects reserved-TLD contacts,
// but Apple endpoints can only ever be subscribed from a real https origin.
const VAPID_SUBJECT = "mailto:operator@web-push.invalid";

export function toPushSubscription(value: unknown): PushSubscription | null {
	if (
		!isRecord(value) ||
		typeof value.endpoint !== "string" ||
		!value.endpoint.startsWith("https://") ||
		!isRecord(value.keys) ||
		typeof value.keys.p256dh !== "string" ||
		typeof value.keys.auth !== "string"
	) {
		return null;
	}
	return { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

function toSubscriptions(value: unknown): StoredSubscription[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const subscription = toPushSubscription(entry);
		if (!subscription) return [];
		const subject = isRecord(entry) && typeof entry.subject === "string" ? entry.subject : undefined;
		return [{ ...subscription, subject }];
	});
}

/** null means the file is missing or unreadable — regenerate rather than crash. */
function parsePushFile(raw: string): PushFile | null {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (
		!isRecord(data) ||
		!isRecord(data.vapid) ||
		typeof data.vapid.publicKey !== "string" ||
		typeof data.vapid.privateKey !== "string"
	) {
		return null;
	}
	return {
		vapid: { publicKey: data.vapid.publicKey, privateKey: data.vapid.privateKey },
		subscriptions: toSubscriptions(data.subscriptions),
	};
}

export async function createWebPushService(config: Config): Promise<WebPushService> {
	const path = resolve(config.workspace.dataDir, "settings", "web-push.json");
	const enqueueWrite = createWriteQueue("web push");
	const raw = await readFileOrNull(path, "utf8");
	const state: PushFile = (raw ? parsePushFile(raw) : null) ?? {
		vapid: webpush.generateVAPIDKeys(),
		subscriptions: [],
	};
	await atomicWriteJson(path, state);
	const persist = (): Promise<void> => enqueueWrite(() => atomicWriteJson(path, state));
	const drop = (endpoint: string): void => {
		state.subscriptions = state.subscriptions.filter((entry) => entry.endpoint !== endpoint);
	};

	return {
		publicKey: () => state.vapid.publicKey,
		subscriptionCount: () => state.subscriptions.length,
		async subscribe(subscription, subject): Promise<void> {
			drop(subscription.endpoint);
			state.subscriptions.push({ ...subscription, subject });
			await persist();
		},
		async unsubscribe(endpoint): Promise<void> {
			drop(endpoint);
			await persist();
		},
		notify({ title, body, tag }): void {
			const payload = JSON.stringify({ title, body, tag });
			for (const subscription of state.subscriptions) {
				const vapidDetails = { subject: subscription.subject ?? VAPID_SUBJECT, ...state.vapid };
				void webpush.sendNotification(subscription, payload, { vapidDetails }).catch((error: unknown) => {
					// 404/410 mean the browser dropped the subscription — prune it.
					if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
						drop(subscription.endpoint);
						void persist();
						return;
					}
					console.error("web push delivery failed:", error);
				});
			}
		},
	};
}
