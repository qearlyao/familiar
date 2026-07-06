import type { WebAuthMode } from "../config/index.js";
import { isRecord } from "../util/guards.js";
import { clearSessionCookie, requestAuthContext, type WebAuth } from "./auth.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { RegisterWebRoute } from "./routes.js";

export function registerWebAuthRoutes(
	route: RegisterWebRoute,
	auth: WebAuth,
	options: { authMode: WebAuthMode; personaName: string },
): void {
	route("GET", "/api/web/auth/mode", async (_request, response) => {
		sendJson(response, 200, { mode: options.authMode, personaName: options.personaName });
	});
	route("POST", "/api/web/auth/login", async (request, response) => {
		const body = await readJsonBody(request);
		const result = await auth.login(request, body);
		sendJson(response, result.status, result.body, result.cookie ? { "set-cookie": result.cookie } : {});
	});
	route("GET", "/api/web/auth/session", async (request, response) => {
		const device = await auth.currentDevice(request);
		if (!device) {
			throw new HttpError(401, "unauthorized");
		}
		const cookie = auth.refreshedSessionCookie(request);
		sendJson(response, 200, { device }, cookie ? { "set-cookie": cookie } : {});
	});
	route("GET", "/api/web/auth/devices", async (request, response) => {
		sendJson(response, 200, { devices: auth.listDevices(request) });
	});
	route("DELETE", "/api/web/auth/devices", async (request, response) => {
		const body = await readJsonBody(request);
		if (!isRecord(body) || typeof body.id !== "string" || !body.id.trim()) {
			throw new HttpError(400, "device id is required");
		}
		await auth.revokeDevice(body.id);
		sendJson(response, 200, { ok: true });
	});
	route("POST", "/api/web/auth/devices/revoke-others", async (request, response) => {
		const revoked = await auth.revokeOthers(request);
		sendJson(response, 200, { ok: true, revoked });
	});
	route("POST", "/api/web/auth/logout", async (request, response) => {
		await auth.logout(request);
		sendJson(response, 200, { ok: true }, { "set-cookie": clearSessionCookie(requestAuthContext(request).secure) });
	});
}
