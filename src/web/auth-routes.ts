import type { IncomingMessage, ServerResponse } from "node:http";

import type { WebAuthMode } from "../config.js";
import { isRecord } from "../util/guards.js";
import { clearSessionCookie, requestAuthContext, type WebAuth } from "./auth.js";
import { readJsonBody, sendJson } from "./http.js";

type WebRoute = (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
type RegisterWebRoute = (method: string, pathname: string, handler: WebRoute) => void;

export function registerWebAuthRoutes(
	route: RegisterWebRoute,
	auth: WebAuth,
	options: { authMode: WebAuthMode; personaName: string },
): void {
	route("GET", "/api/web/auth/mode", async (_request, response) => {
		sendJson(response, 200, { mode: options.authMode, personaName: options.personaName });
		return true;
	});
	route("POST", "/api/web/auth/login", async (request, response) => {
		const body = await readJsonBody(request);
		const result = await auth.login(request, body);
		sendJson(response, result.status, result.body, result.cookie ? { "set-cookie": result.cookie } : {});
		return true;
	});
	route("GET", "/api/web/auth/session", async (request, response) => {
		const device = await auth.currentDevice(request);
		if (!device) {
			sendJson(response, 401, { error: "unauthorized" });
			return true;
		}
		sendJson(response, 200, { device });
		return true;
	});
	route("GET", "/api/web/auth/devices", async (request, response) => {
		sendJson(response, 200, { devices: auth.listDevices(request) });
		return true;
	});
	route("DELETE", "/api/web/auth/devices", async (request, response) => {
		const body = await readJsonBody(request);
		if (!isRecord(body) || typeof body.id !== "string" || !body.id.trim()) {
			sendJson(response, 400, { error: "device id is required" });
			return true;
		}
		await auth.revokeDevice(body.id);
		sendJson(response, 200, { ok: true });
		return true;
	});
	route("POST", "/api/web/auth/devices/revoke-others", async (request, response) => {
		const revoked = await auth.revokeOthers(request);
		sendJson(response, 200, { ok: true, revoked });
		return true;
	});
	route("POST", "/api/web/auth/logout", async (request, response) => {
		await auth.logout(request);
		sendJson(response, 200, { ok: true }, { "set-cookie": clearSessionCookie(requestAuthContext(request).secure) });
		return true;
	});
}
