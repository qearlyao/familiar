import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import type { FamiliarAgent } from "../src/agent/factory.js";
import { setAddedModelsPath } from "../src/models/added-models.js";
import { registerWebAgentRoutes } from "../src/web/agent-routes.js";
import type { RegisterWebRoute, WebRoute } from "../src/web/routes.js";
import type { WebStreamEvent } from "../src/web/types.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

class FakeResponse {
	statusCode?: number;
	body = "";

	writeHead(statusCode: number): void {
		this.statusCode = statusCode;
	}

	end(chunk?: string | Buffer): void {
		if (chunk) this.body += chunk.toString();
	}
}

function jsonRequest(body: unknown): IncomingMessage {
	return Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
}

function registerAgentModelRoutes(config: Parameters<typeof registerWebAgentRoutes>[0]["config"]): Map<string, WebRoute> {
	const routes = new Map<string, WebRoute>();
	const route: RegisterWebRoute = (method, pathname, handler) => routes.set(`${method} ${pathname}`, handler);
	registerWebAgentRoutes({
		route,
		config,
		familiarAgent: {} as FamiliarAgent,
		getRuntime: async () => ({ channelKey: "test" }) as never,
		personaName: "test",
		publish: (event) => ({ ...event, eventId: "event", ts: event.ts ?? 0 }) as WebStreamEvent,
	});
	return routes;
}

describe("web agent model routes", () => {
	it("lets configured custom providers add models manually", async (t) => {
		const dataDir = await createTempDataDir(t);
		t.after(() => setAddedModelsPath(resolve(process.cwd(), "data")));
		setAddedModelsPath(dataDir);
		const config = await configWithDataDir(t, dataDir, {
			models: {
				baseUrls: { gua: "https://gua.example.test" },
				apiKeyEnvs: { gua: "GUA_API_KEY" },
				providers: {
					gua: {
						api: "anthropic-messages",
						reasoning: true,
						input: ["text", "image"],
						contextWindow: 200000,
						maxTokens: 8192,
						models: [],
					},
				},
			},
		});
		const routes = registerAgentModelRoutes(config);
		const handler = routes.get("POST /api/web/agent/models");
		assert.ok(handler);
		const response = new FakeResponse();

		await handler(
			jsonRequest({ model: "gua/claude-opus-4-8" }),
			response as unknown as ServerResponse,
			new URL("http://localhost/api/web/agent/models"),
		);

		const payload = JSON.parse(response.body) as { models: string[]; added: string[] };
		assert.equal(response.statusCode, 200);
		assert.ok(payload.models.includes("gua/claude-opus-4-8"));
		assert.deepEqual(payload.added, ["gua/claude-opus-4-8"]);
	});

	it("rejects configured custom providers that the model layer cannot resolve", async (t) => {
		const dataDir = await createTempDataDir(t);
		t.after(() => setAddedModelsPath(resolve(process.cwd(), "data")));
		setAddedModelsPath(dataDir);
		const config = await configWithDataDir(t, dataDir, {
			models: {
				providers: {
					gua: {
						api: "anthropic-messages",
						models: [],
					},
				},
			},
		});
		const handler = registerAgentModelRoutes(config).get("POST /api/web/agent/models");
		assert.ok(handler);

		await assert.rejects(
			() =>
				handler(
					jsonRequest({ model: "gua/claude-opus-4-8" }),
					new FakeResponse() as unknown as ServerResponse,
					new URL("http://localhost/api/web/agent/models"),
				),
			/Missing model base URL for gua\/claude-opus-4-8/,
		);
	});
});
