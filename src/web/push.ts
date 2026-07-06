import { resolve } from "node:path";

import webpush, { type PushSubscription } from "web-push";

import type { Config } from "../config/index.js";
import { atomicWriteJson, createWriteQueue, readFileOrNull } from "../util/fs.js";

// A browser PushSubscription plus the persona-facing metadata we key devices on.
interface StoredSubscription {
	subscription: PushSubscription;
	deviceName?: string;
	createdAt: string;
}

interface PushFile {
	vapidPublicKey: string;
	vapidPrivateKey: string;
	subscriptions: StoredSubscription[];
}

export interface PushNotification {
	title: string;
	body: string;
	url?: string;
	tag?: string;
}

export interface PushService {
	publicKey: string;
	subscribe(subscription: PushSubscription, deviceName?: string): Promise<void>;
	unsubscribe(endpoint: string): Promise<void>;
	notify(notification: PushNotification): Promise<void>;
}

// web-push demands a mailto:/https: subject for the VAPID JWT; it is never shown to anyone.
const VAPID_SUBJECT = "mailto:familiar@localhost";

async function readPushFile(path: string): Promise<{ file: PushFile; isNew: boolean }> {
	const raw = await readFileOrNull(path, "utf8");
	if (raw === null) {
		const keys = webpush.generateVAPIDKeys();
		return {
			file: { vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, subscriptions: [] },
			isNew: true,
		};
	}
	const parsed = JSON.parse(raw) as PushFile;
	return { file: { ...parsed, subscriptions: parsed.subscriptions ?? [] }, isNew: false };
}

export async function createPushService(config: Config): Promise<PushService> {
	const path = resolve(config.workspace.dataDir, "settings", "web-push.json");
	const { file, isNew } = await readPushFile(path);
	webpush.setVapidDetails(VAPID_SUBJECT, file.vapidPublicKey, file.vapidPrivateKey);

	const enqueueWrite = createWriteQueue("web push");
	const persist = (): Promise<void> => enqueueWrite(() => atomicWriteJson(path, file));

	// Persist a freshly-minted keypair immediately so it survives restarts.
	if (isNew) await persist();

	const dropEndpoint = (endpoint: string): void => {
		file.subscriptions = file.subscriptions.filter((entry) => entry.subscription.endpoint !== endpoint);
	};

	return {
		publicKey: file.vapidPublicKey,
		async subscribe(subscription, deviceName): Promise<void> {
			dropEndpoint(subscription.endpoint);
			file.subscriptions.push({ subscription, deviceName, createdAt: new Date().toISOString() });
			await persist();
		},
		async unsubscribe(endpoint): Promise<void> {
			dropEndpoint(endpoint);
			await persist();
		},
		async notify(notification): Promise<void> {
			if (file.subscriptions.length === 0) return;
			const payload = JSON.stringify(notification);
			const stale: string[] = [];
			await Promise.all(
				file.subscriptions.map(async (entry) => {
					try {
						await webpush.sendNotification(entry.subscription, payload);
					} catch (error) {
						// 404/410 mean the browser dropped the subscription; prune it. Others are transient.
						const status = (error as { statusCode?: number }).statusCode;
						if (status === 404 || status === 410) stale.push(entry.subscription.endpoint);
					}
				}),
			);
			if (stale.length > 0) {
				for (const endpoint of stale) dropEndpoint(endpoint);
				await persist();
			}
		},
	};
}
