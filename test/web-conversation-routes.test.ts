import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import type { FamiliarAgent } from "../src/agent/factory.js";
import type { AgentCore } from "../src/runtime/agent-core.js";
import type { ConversationRuntime, InboundDispatchOptions, InboundMessageInput } from "../src/runtime/conversation-runtime.js";
import { registerWebConversationRoutes } from "../src/web/conversation-routes.js";
import type { RegisterWebRoute, WebRoute } from "../src/web/routes.js";
import type { WebAuth } from "../src/web/auth.js";
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
	const request = Readable.from([JSON.stringify(body)]) as Readable & { headers: Record<string, string> };
	request.headers = { "content-type": "application/json" };
	return request as unknown as IncomingMessage;
}

describe("web conversation routes", () => {
	it("steers active DM WebUI sends when discord dm_mode is steer", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t), {
			discord: { dmMode: "steer" },
		});
		const routes = new Map<string, WebRoute>();
		const route: RegisterWebRoute = (method, pathname, handler) => routes.set(`${method} ${pathname}`, handler);
		const modes: Array<InboundDispatchOptions["mode"]> = [];
		const steered: string[] = [];
		let drained = false;
		const runtime = {
			channel: { service: "discord", scope: "dm", channelId: "dm-1" },
			channelKey: "discord:dm:dm-1",
			hasActiveJob: () => true,
			ingestInbound: async (input: InboundMessageInput, options: InboundDispatchOptions) => {
				modes.push(options.mode);
				return {
					jobQueued: false,
					record: {
						type: "inbound",
						recordId: 1,
						ts: input.remoteTimestamp ?? "",
						service: "discord",
						scope: "dm",
						channelId: "dm-1",
						messageId: input.messageId,
						authorId: input.authorId,
						authorName: input.authorName,
						text: input.text.trim(),
						isBot: false,
						mentionedBot: true,
						attachments: [],
					},
				};
			},
			buildSteerPromptForRecord: (record: { text: string }) => `steer:${record.text}`,
		} as unknown as ConversationRuntime;
		const actions = {
			drainJobs: async () => {
				drained = true;
			},
		} as unknown as import("../src/web/runtime-actions.js").WebRuntimeActions;
		const familiarAgent = {
			steer: (_sessionKey: string, prompt: string) => steered.push(prompt),
		} as unknown as FamiliarAgent;

		registerWebConversationRoutes({
			route,
			config,
			auth: {} as WebAuth,
			authMode: "tailscale-only",
			agentCore: { activeOwner: runtime.channelKey } as AgentCore,
			getRuntime: async () => runtime,
			personaName: "familiar",
			actions,
			familiarAgent,
		});
		const handler = routes.get("POST /api/web/send");
		assert.ok(handler);
		const response = new FakeResponse();

		await handler(
			jsonRequest({ text: "use the shorter path" }),
			response as unknown as ServerResponse,
			new URL("http://localhost/api/web/send"),
		);

		assert.equal(response.statusCode, 200);
		assert.deepEqual(modes, ["collect"]);
		assert.deepEqual(steered, ["steer:use the shorter path"]);
		assert.equal(drained, false);
	});
});
