import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createChatLog } from "../src/chat-log.js";
import { ConversationRuntime } from "../src/runtime.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

describe("ConversationRuntime", () => {
	it("renders prompt timestamps in local time while preserving stored UTC timestamps", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir);
		const runtime = await ConversationRuntime.connect({
			channelKey: "web-web-owner",
			log: createChatLog(config, { service: "web", scope: "web", channelId: "owner" }),
			ownerId: "owner",
		});

		try {
			await runtime.armAfterCurrentTail();
			const { record } = await runtime.ingestInbound({
				messageId: "message-1",
				authorId: "owner",
				authorName: "qearlyao",
				text: "hello",
				remoteTimestamp: "2026-05-09T03:34:16.881Z",
			});

			assert.equal(record.ts, "2026-05-09T03:34:16.881Z");
			const prompt = runtime.buildSteerPromptForRecord(record);
			assert.match(prompt, / @ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT[+-]\d{1,2}/);
			assert.doesNotMatch(prompt, /2026-05-09T03:34:16\.881Z/);
		} finally {
			await runtime.disconnect();
		}
	});

	it("includes derived attachment text once in prompt records", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir);
		const runtime = await ConversationRuntime.connect({
			channelKey: "web-web-owner",
			log: createChatLog(config, { service: "web", scope: "web", channelId: "owner" }),
			ownerId: "owner",
		});

		try {
			await runtime.armAfterCurrentTail();
			const { record } = await runtime.ingestInbound({
				messageId: "message-1",
				authorId: "owner",
				authorName: "qearlyao",
				text: "",
				remoteTimestamp: "2026-05-09T03:34:16.881Z",
				attachments: [
					{
						id: "attachment-1",
						name: "voice-message.ogg",
						kind: "audio",
						mimeType: "audio/ogg",
						size: 9595,
						derived: {
							text: {
								provider: "groq",
								model: "whisper-large-v3",
								label: "transcription",
								text: "Hello, can you hear me?",
							},
						},
					},
				],
			});

			const prompt = runtime.buildSteerPromptForRecord(record);
			assert.equal((prompt.match(/<attachment name="voice-message\.ogg"/g) ?? []).length, 1);
			assert.equal((prompt.match(/\[transcription: Hello, can you hear me\?\]/g) ?? []).length, 1);
		} finally {
			await runtime.disconnect();
		}
	});

	it("tracks last heartbeat-reset interaction from owner inbound records only", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir);
		const runtime = await ConversationRuntime.connect({
			channelKey: "web-web-owner",
			log: createChatLog(config, { service: "web", scope: "web", channelId: "owner" }),
			ownerId: "owner",
		});

		try {
			await runtime.armAfterCurrentTail();
			await runtime.ingestInbound({
				messageId: "message-1",
				authorId: "owner",
				authorName: "qearlyao",
				text: "hello",
				remoteTimestamp: "2026-05-09T03:34:16.881Z",
			});
			assert.equal(runtime.getLastUserInteractionAt(), Date.parse("2026-05-09T03:34:16.881Z"));

			await runtime.noteOutbound({
				text: "hi",
				messageIds: ["message-2"],
			});
			assert.equal(runtime.getLastUserInteractionAt(), Date.parse("2026-05-09T03:34:16.881Z"));

			await runtime.ingestInbound({
				messageId: "message-3",
				authorId: "someone-else",
				authorName: "Other",
				text: "not owner",
				remoteTimestamp: "2026-05-09T04:34:16.881Z",
			});
			assert.equal(runtime.getLastUserInteractionAt(), Date.parse("2026-05-09T03:34:16.881Z"));

			await runtime.ingestInbound({
				messageId: "message-4",
				authorId: "owner",
				authorName: "qearlyao",
				text: "reply",
				remoteTimestamp: "2026-05-09T05:34:16.881Z",
			});
			assert.equal(runtime.getLastUserInteractionAt(), Date.parse("2026-05-09T05:34:16.881Z"));
		} finally {
			await runtime.disconnect();
		}
	});

	it("parses reload and restart as owner-only control commands", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir);
		const runtime = await ConversationRuntime.connect({
			channelKey: "web-web-owner",
			log: createChatLog(config, { service: "web", scope: "web", channelId: "owner" }),
			ownerId: "owner",
			botUserId: "bot",
		});

		try {
			assert.deepEqual(
				runtime.parseControlCommand({
					authorId: "owner",
					text: "/reload",
					isBot: false,
				}),
				{ command: "reload", args: "" },
			);
			assert.deepEqual(
				runtime.parseControlCommand({
					authorId: "owner",
					text: "<@bot> reload",
					isBot: false,
					mentionedBot: true,
				}),
				{ command: "reload", args: "" },
			);
			assert.deepEqual(
				runtime.parseControlCommand({
					authorId: "owner",
					text: "/restart",
					isBot: false,
				}),
				{ command: "restart", args: "" },
			);
			assert.deepEqual(
				runtime.parseControlCommand({
					authorId: "owner",
					text: "<@bot> restart",
					isBot: false,
					mentionedBot: true,
				}),
				{ command: "restart", args: "" },
			);
			assert.equal(
				runtime.parseControlCommand({
					authorId: "someone-else",
					text: "/restart",
					isBot: false,
				}),
				undefined,
			);
		} finally {
			await runtime.disconnect();
		}
	});
});
