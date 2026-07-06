import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";

import { createAuth, loadWebSessionStore, requestAuthContext, sessionCookie, verifyTotp } from "../src/web/auth.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

function request(
	headers: Record<string, string> = {},
	method = "GET",
	remoteAddress = "127.0.0.1",
): IncomingMessage {
	return { headers, method, socket: { remoteAddress } } as IncomingMessage;
}

async function bearerAuth(t: Parameters<typeof configWithDataDir>[0], token = "secret") {
	const dataDir = await createTempDataDir(t);
	const config = await configWithDataDir(t, dataDir, {
		web: { authMode: "bearer", bearerToken: token },
	});
	const store = await loadWebSessionStore(config);
	return { auth: createAuth(config, store), config, dataDir };
}

describe("verifyTotp", () => {
	const secret = "12345678901234567890";

	it("accepts a valid current token", () => {
		assert.equal(verifyTotp(secret, "287082", 59_000), true);
	});

	it("accepts one time step of window skew", () => {
		assert.equal(verifyTotp(secret, "287082", 89_000), true);
	});

	it("rejects bad or malformed tokens", () => {
		assert.equal(verifyTotp(secret, "000000", 59_000), false);
		assert.equal(verifyTotp(secret, "not-code", 59_000), false);
	});
});

describe("createAuth.authorize", () => {
	it("allows all requests in tailscale-only mode", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const auth = createAuth(config, await loadWebSessionStore(config));

		assert.equal(await auth.authorize(request(), "/api/web/stream"), true);
	});

	it("requires the configured bearer token in bearer mode", async (t) => {
		const { auth } = await bearerAuth(t);

		assert.equal(await auth.authorize(request(), "/api/web/stream"), false);
		assert.equal(await auth.authorize(request({ authorization: "Bearer secret" }), "/api/web/stream"), true);
	});

	it("allows session or bearer auth in public-2fa mode", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			web: { authMode: "public-2fa", bearerToken: "secret" },
		});
		const auth = createAuth(config, await loadWebSessionStore(config));
		const session = await auth.createSession(request(), "test device");

		assert.equal(await auth.authorize(request(), "/api/web/stream"), false);
		assert.equal(await auth.authorize(request({ cookie: sessionCookie(session.token, false) }), "/api/web/stream"), true);
		assert.equal(await auth.authorize(request({ authorization: "Bearer secret" }), "/api/web/stream"), true);
	});

	it("allows the auth mode endpoint without credentials", async (t) => {
		const { auth } = await bearerAuth(t);

		assert.equal(await auth.authorize(request({}, "GET"), "/api/web/auth/mode"), true);
	});

	it("only exposes the bearer login endpoint in bearer mode", async (t) => {
		const dataDir = await createTempDataDir(t);
		const bearer = await configWithDataDir(t, dataDir, {
			web: { authMode: "bearer", bearerToken: "secret" },
		});
		const public2fa = await configWithDataDir(t, dataDir, {
			web: { authMode: "public-2fa", bearerToken: "secret" },
		});

		assert.equal(
			await createAuth(bearer, await loadWebSessionStore(bearer)).authorize(
				request({}, "POST"),
				"/api/web/auth/login",
			),
			true,
		);
		assert.equal(
			await createAuth(public2fa, await loadWebSessionStore(public2fa)).authorize(
				request({}, "POST"),
				"/api/web/auth/login",
			),
			false,
		);
	});
});

describe("bearer login sessions", () => {
	it("creates a persistent cookie-backed device session", async (t) => {
		const { auth, config } = await bearerAuth(t);
		const loginRequest = request(
			{
				"user-agent": "Mobile Safari",
				"x-forwarded-for": "203.0.113.7",
				"x-forwarded-proto": "https",
			},
			"POST",
		);

		const result = await auth.login(loginRequest, { token: "secret", deviceName: "phone" });

		assert.equal(result.status, 200);
		assert.match(result.cookie ?? "", /familiar_session=/);
		assert.match(result.cookie ?? "", /Secure/);
		assert.deepEqual(result.body, {
			device: {
				id: (result.body as { device: { id: string } }).device.id,
				deviceName: "phone",
				createdAt: (result.body as { device: { createdAt: string } }).device.createdAt,
				lastSeenAt: (result.body as { device: { lastSeenAt: string } }).device.lastSeenAt,
				expiresAt: (result.body as { device: { expiresAt: string } }).device.expiresAt,
				lastIp: "203.0.113.7",
				userAgent: "Mobile Safari",
				current: true,
			},
		});

		const authedHeaders = {
			cookie: result.cookie ?? "",
			"user-agent": "Mobile Safari",
			"x-forwarded-for": "203.0.113.7",
			"x-forwarded-proto": "https",
		};
		const reloaded = createAuth(config, await loadWebSessionStore(config));
		assert.equal(await reloaded.authorize(request(authedHeaders), "/api/web/stream"), true);
		assert.equal((await reloaded.currentDevice(request(authedHeaders)))?.deviceName, "phone");
	});

	it("does not store or accept revoked sessions", async (t) => {
		const { auth, config } = await bearerAuth(t);
		const result = await auth.login(request({}, "POST"), { token: "secret" });
		const cookie = result.cookie ?? "";

		assert.equal(await auth.authorize(request({ cookie }), "/api/web/history"), true);
		assert.equal(await auth.logout(request({ cookie })), true);

		const reloaded = createAuth(config, await loadWebSessionStore(config));
		assert.equal(await reloaded.authorize(request({ cookie }), "/api/web/history"), false);
	});

	it("expires idle sessions after thirty days", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			web: { authMode: "bearer", bearerToken: "secret" },
		});
		const store = await loadWebSessionStore(config, 0);
		const session = await store.createSession({
			context: { clientIp: "127.0.0.1", now: 0, secure: false },
			deviceName: "old browser",
		});

		const expired = createAuth(config, await loadWebSessionStore(config, 31 * 24 * 60 * 60 * 1000));

		assert.equal(
			await expired.authorize(request({ cookie: sessionCookie(session.token, false) }), "/api/web/history"),
			false,
		);
	});

	it("awaits session touch persistence before authorization returns", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			web: { authMode: "bearer", bearerToken: "secret" },
		});
		const createdAt = Date.now() - 2 * 60 * 1000;
		const store = await loadWebSessionStore(config, createdAt);
		const session = await store.createSession({
			context: { clientIp: "127.0.0.1", now: createdAt, secure: false },
			deviceName: "browser",
		});
		const auth = createAuth(config, store);

		assert.equal(
			await auth.authorize(
				request({ cookie: sessionCookie(session.token, false), "user-agent": "Updated Browser" }),
				"/api/web/history",
			),
			true,
		);

		const raw = JSON.parse(await readFile(store.path, "utf8")) as {
			sessions: Array<{ userAgent?: string; lastSeenAt: string }>;
		};
		assert.equal(raw.sessions[0]?.userAgent, "Updated Browser");
		assert.notEqual(raw.sessions[0]?.lastSeenAt, new Date(createdAt).toISOString());
	});

	it("revokes all non-current sessions in one store mutation", async (t) => {
		const { auth, config } = await bearerAuth(t);
		const current = await auth.login(request({}, "POST"), { token: "secret", deviceName: "current" });
		const otherA = await auth.login(request({}, "POST"), { token: "secret", deviceName: "other a" });
		const otherB = await auth.login(request({}, "POST"), { token: "secret", deviceName: "other b" });
		const currentCookie = current.cookie ?? "";

		assert.equal(await auth.revokeOthers(request({ cookie: currentCookie })), 2);

		const reloaded = createAuth(config, await loadWebSessionStore(config));
		assert.equal(await reloaded.authorize(request({ cookie: currentCookie }), "/api/web/history"), true);
		assert.equal(await reloaded.authorize(request({ cookie: otherA.cookie ?? "" }), "/api/web/history"), false);
		assert.equal(await reloaded.authorize(request({ cookie: otherB.cookie ?? "" }), "/api/web/history"), false);
	});

	it("re-issues the session cookie so its Max-Age slides with activity", async (t) => {
		const { auth } = await bearerAuth(t);
		const result = await auth.login(request({}, "POST"), { token: "secret" });
		const cookie = result.cookie ?? "";

		const refreshed = auth.refreshedSessionCookie(request({ cookie }));
		assert.match(refreshed ?? "", /familiar_session=/);
		assert.match(refreshed ?? "", /Max-Age=2592000/);
		assert.equal(auth.refreshedSessionCookie(request()), undefined);
	});

	it("rate limits repeated failed login attempts", async (t) => {
		const { auth } = await bearerAuth(t);
		const loginRequest = request({}, "POST", "198.51.100.10");

		for (let attempt = 0; attempt < 5; attempt++) {
			const result = await auth.login(loginRequest, { token: "wrong" });
			assert.equal(result.status, 401);
		}

		const limited = await auth.login(loginRequest, { token: "wrong" });
		assert.equal(limited.status, 429);
		assert.deepEqual(limited.body, { error: "too many login attempts" });
	});

	it("uses forwarded IP and proto only for loopback proxy connections", () => {
		const loopback = request(
			{
				"x-forwarded-for": "203.0.113.8, 10.0.0.1",
				"x-forwarded-proto": "https",
			},
			"GET",
			"127.0.0.1",
		);
		const remote = request(
			{
				"x-forwarded-for": "203.0.113.9",
				"x-forwarded-proto": "https",
			},
			"GET",
			"198.51.100.20",
		);

		assert.deepEqual(requestAuthContext(loopback, 1), {
			clientIp: "203.0.113.8",
			secure: true,
			now: 1,
		});
		assert.deepEqual(requestAuthContext(remote, 1), {
			clientIp: "198.51.100.20",
			secure: false,
			now: 1,
		});
	});
});
