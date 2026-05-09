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
});
