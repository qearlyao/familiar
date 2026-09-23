import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { it } from "node:test";

import type { Config } from "../src/config/index.js";
import type { WebAuth } from "../src/web/auth.js";
import { HttpError } from "../src/web/http.js";
import { createWebRouteRegistry } from "../src/web/routes.js";
import { FakeResponse, jsonRequest } from "./helpers.js";

it("hides unexpected web API errors while logging them", async (t) => {
	const logged = t.mock.method(console, "error", () => {});
	const registry = createWebRouteRegistry({} as Config, { authorize: async () => true } as unknown as WebAuth);
	const failure = new Error("private path /srv/app/secrets.ts\n    at handler (/srv/app/secrets.ts:12:3)");
	registry.route("POST", "/api/web/test", async () => {
		throw failure;
	});
	const response = new FakeResponse();
	await registry.handleApi(
		jsonRequest({}),
		response as unknown as ServerResponse,
		new URL("http://localhost/api/web/test"),
	);
	assert.equal(response.statusCode, 500);
	assert.deepEqual(JSON.parse(response.body), { error: "Internal server error" });
	assert.equal(logged.mock.calls.length, 1);
	assert.equal(logged.mock.calls[0]?.arguments[1], failure);
});

it("keeps deliberate web API validation errors", async () => {
	const registry = createWebRouteRegistry({} as Config, { authorize: async () => true } as unknown as WebAuth);
	registry.route("POST", "/api/web/test", async () => {
		throw new HttpError(400, "Invalid request");
	});
	const response = new FakeResponse();
	await registry.handleApi(
		jsonRequest({}),
		response as unknown as ServerResponse,
		new URL("http://localhost/api/web/test"),
	);
	assert.equal(response.statusCode, 400);
	assert.deepEqual(JSON.parse(response.body), { error: "Invalid request" });
});
