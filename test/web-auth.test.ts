import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { IncomingMessage } from "node:http";

import { createAuth, sessionCookie, verifyTotp } from "../src/web-auth.js";
import { configWithDataDir } from "./helpers.js";

function request(headers: Record<string, string> = {}): IncomingMessage {
	return { headers } as IncomingMessage;
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
		const auth = createAuth(await configWithDataDir(t, "/workspace/data"));

		assert.equal(auth.authorize(request(), "/api/web/stream"), true);
	});

	it("requires the configured bearer token in bearer mode", async (t) => {
		const auth = createAuth(
			await configWithDataDir(t, "/workspace/data", {
				web: { authMode: "bearer", bearerToken: "secret" },
			}),
		);

		assert.equal(auth.authorize(request(), "/api/web/stream"), false);
		assert.equal(auth.authorize(request({ authorization: "Bearer secret" }), "/api/web/stream"), true);
	});

	it("allows session or bearer auth in public-2fa mode", async (t) => {
		const auth = createAuth(
			await configWithDataDir(t, "/workspace/data", {
				web: { authMode: "public-2fa", bearerToken: "secret" },
			}),
		);
		const session = auth.createSession();

		assert.equal(auth.authorize(request(), "/api/web/stream"), false);
		assert.equal(auth.authorize(request({ cookie: sessionCookie(session) }), "/api/web/stream"), true);
		assert.equal(auth.authorize(request({ authorization: "Bearer secret" }), "/api/web/stream"), true);
	});

	it("allows the auth mode endpoint without credentials", async (t) => {
		const auth = createAuth(
			await configWithDataDir(t, "/workspace/data", {
				web: { authMode: "bearer", bearerToken: "secret" },
			}),
		);

		assert.equal(auth.authorize(request(), "/api/web/auth/mode"), true);
	});
});
