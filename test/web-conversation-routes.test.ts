import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import type { FamiliarAgent } from "../src/agent/factory.js";
import type { ChatLogRecord } from "../src/conversation/chat-log.js";
import type { AgentCore } from "../src/runtime/agent-core.js";
import type { ConversationRuntime, InboundDispatchOptions, InboundMessageInput } from "../src/runtime/conversation-runtime.js";
import { registerWebConversationRoutes } from "../src/web/conversation-routes.js";
import { createWebEventHub } from "../src/web/event-hub.js";
import { decodeFrames, type WebSocketClient } from "../src/web/events.js";
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

function multipartRequest(fields: Record<string, string>): IncomingMessage {
	const boundary = "familiar-test-boundary";
	const body = `${Object.entries(fields)
		.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
		.join("")}--${boundary}--\r\n`;
	const request = Readable.from([body]) as Readable & { headers: Record<string, string> };
	request.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
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
		const inputs: InboundMessageInput[] = [];
		const records: ChatLogRecord[] = [];
		const steered: string[] = [];
		let drained = false;
		let recordListener: (record: ChatLogRecord) => void | Promise<void> = () => undefined;
		const runtime = {
			channel: { service: "discord", scope: "dm", channelId: "dm-1" },
			channelKey: "discord:dm:dm-1",
			ownerId: "runtime-owner",
			hasActiveJob: () => true,
			getRecords: () => records,
			subscribe: (listener: typeof recordListener) => {
				recordListener = listener;
				return () => undefined;
			},
			subscribeAgentEvents: () => () => undefined,
			ingestInbound: async (input: InboundMessageInput, options: InboundDispatchOptions) => {
				inputs.push(input);
				modes.push(options.mode);
				const record: Extract<ChatLogRecord, { type: "inbound" }> = {
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
						bookId: input.bookId,
						isBot: false,
						mentionedBot: true,
						attachments: [],
					};
				records.push(record);
				await recordListener(record);
				return { jobQueued: false, record };
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
		const frames: Buffer[] = [];
		const eventHub = createWebEventHub(config, "familiar");
		t.after(() => eventHub.stop());
		eventHub.subscribeRuntime(runtime);
		eventHub.registerClient({
			channelKey: runtime.channelKey,
			authed: true,
			socket: {
				destroyed: false,
				write: (chunk: Uint8Array) => {
					frames.push(Buffer.from(chunk));
					return true;
				},
				destroy: () => undefined,
			},
		} as unknown as WebSocketClient);

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
		assert.ok(routes.has("GET /api/web/book/conversation"));
		const response = new FakeResponse();

		await handler(
			multipartRequest({ text: "use the shorter path", bookId: "aaaaaaaaaa" }),
			response as unknown as ServerResponse,
			new URL("http://localhost/api/web/send"),
		);

		assert.equal(response.statusCode, 200);
		assert.equal(inputs[0]?.bookId, "aaaaaaaaaa");
		assert.equal(inputs[0]?.authorId, "runtime-owner");
		const events = decodeFrames(Buffer.concat(frames)).messages.map((message) => JSON.parse(message) as Record<string, unknown>);
		assert.equal(events.find((event) => event.type === "message_started")?.bookId, "aaaaaaaaaa");
		records.push({
			type: "outbound",
			recordId: 2,
			ts: new Date().toISOString(),
			service: "discord",
			scope: "dm",
			channelId: "dm-1",
			messageIds: ["assistant-1"],
			webMessageId: "assistant-1",
			text: "book reply",
		});
		const conversationHandler = routes.get("GET /api/web/book/conversation");
		assert.ok(conversationHandler);
		const conversationResponse = new FakeResponse();
		await conversationHandler(
			jsonRequest({}),
			conversationResponse as unknown as ServerResponse,
			new URL("http://localhost/api/web/book/conversation?id=aaaaaaaaaa&channelKey=discord%3Adm%3Adm-1"),
		);
		const { messages } = JSON.parse(conversationResponse.body) as { messages: Array<{ text: string }> };
		assert.deepEqual(messages.map((message) => message.text), ["use the shorter path", "book reply"]);
		assert.deepEqual(modes, ["collect"]);
		assert.deepEqual(steered, ["steer:use the shorter path"]);
		assert.equal(drained, false);
	});

	it("enriches sessions with context tokens from the last message_end usage", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const routes = new Map<string, WebRoute>();
		const route: RegisterWebRoute = (method, pathname, handler) => routes.set(`${method} ${pathname}`, handler);
		const records = [
			{ type: "agent_event", event: { type: "message_end", role: "assistant", usage: { input: 100, output: 20, cacheRead: 800, cacheWrite: 80, cost: 0 } } },
			{ type: "agent_event", event: { type: "message_end", role: "assistant", usage: { input: 200, output: 50, cacheRead: 1600, cacheWrite: 150, cost: 0 } } },
			{ type: "checkpoint" },
		];
	const agentCore = {
			getWebSessions: async () => [
				{ key: "discord:dm:dm-1", label: "Main Chat", channel: { service: "discord", scope: "dm", channelId: "dm-1" }, isDefault: true },
				{ key: "discord:channel:c-2", label: "side", channel: { service: "discord", scope: "channel", channelId: "c-2" } },
			],
			peekRuntime: async (channelKey: string) =>
				channelKey === "discord:dm:dm-1" ? ({ getRecords: () => records } as unknown as ConversationRuntime) : undefined,
		} as unknown as AgentCore;
		const familiarAgent = {
			resolveChannelModel: () => ({ model: { contextWindow: 100_000 } }),
		} as unknown as FamiliarAgent;

		registerWebConversationRoutes({
			route,
			config,
			auth: {} as WebAuth,
			authMode: "tailscale-only",
			agentCore,
			getRuntime: async () => {
				throw new Error("unused");
			},
			personaName: "familiar",
			actions: {} as import("../src/web/runtime-actions.js").WebRuntimeActions,
			familiarAgent,
		});
		const handler = routes.get("GET /api/web/sessions");
		assert.ok(handler);
		const response = new FakeResponse();

		await handler(
			jsonRequest({}),
			response as unknown as ServerResponse,
			new URL("http://localhost/api/web/sessions"),
		);

		assert.equal(response.statusCode, 200);
		const { sessions } = JSON.parse(response.body) as { sessions: Array<{ key: string; context?: unknown }> };
		assert.deepEqual(sessions[0].context, { tokens: 2000, limit: 100_000 });
		assert.equal(sessions[1].context, undefined);
	});
});
