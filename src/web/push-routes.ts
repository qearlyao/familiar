import { isRecord } from "../util/guards.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { toPushSubscription, type WebPushService } from "./push.js";
import type { RegisterWebRoute } from "./routes.js";

export function registerWebPushRoutes(route: RegisterWebRoute, push: WebPushService): void {
	route("GET", "/api/web/push/key", async (_request, response) => {
		sendJson(response, 200, { key: push.publicKey() });
	});
	route("POST", "/api/web/push/subscriptions", async (request, response) => {
		const subscription = toPushSubscription(await readJsonBody(request));
		if (!subscription) throw new HttpError(400, "invalid push subscription");
		// APNs rejects placeholder contacts, so the page's own https origin is the VAPID subject.
		const origin = request.headers.origin;
		await push.subscribe(subscription, origin?.startsWith("https://") ? origin : undefined);
		sendJson(response, 200, { ok: true });
	});
	route("DELETE", "/api/web/push/subscriptions", async (request, response) => {
		const body = await readJsonBody(request);
		if (!isRecord(body) || typeof body.endpoint !== "string") {
			throw new HttpError(400, "endpoint is required");
		}
		await push.unsubscribe(body.endpoint);
		sendJson(response, 200, { ok: true });
	});
}
