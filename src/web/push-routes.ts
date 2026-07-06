import type { PushSubscription } from "web-push";

import { isRecord } from "../util/guards.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { PushService } from "./push.js";
import type { RegisterWebRoute } from "./routes.js";

function subscriptionFromBody(body: unknown): { subscription: PushSubscription; deviceName?: string } {
	if (!isRecord(body) || !isRecord(body.subscription)) throw new HttpError(400, "subscription is required");
	const { endpoint, keys } = body.subscription;
	if (typeof endpoint !== "string" || !endpoint) throw new HttpError(400, "subscription.endpoint is required");
	if (!isRecord(keys) || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
		throw new HttpError(400, "subscription.keys must include p256dh and auth");
	}
	return {
		subscription: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
		deviceName: typeof body.deviceName === "string" ? body.deviceName : undefined,
	};
}

export function registerWebPushRoutes(route: RegisterWebRoute, push: PushService): void {
	route("GET", "/api/web/push/key", async (_request, response) => {
		sendJson(response, 200, { key: push.publicKey });
	});
	route("POST", "/api/web/push/subscribe", async (request, response) => {
		const { subscription, deviceName } = subscriptionFromBody(await readJsonBody(request));
		await push.subscribe(subscription, deviceName);
		sendJson(response, 200, { ok: true });
	});
	route("DELETE", "/api/web/push/subscribe", async (request, response) => {
		const body = await readJsonBody(request);
		if (!isRecord(body) || typeof body.endpoint !== "string") throw new HttpError(400, "endpoint is required");
		await push.unsubscribe(body.endpoint);
		sendJson(response, 200, { ok: true });
	});
}
