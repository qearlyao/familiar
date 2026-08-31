import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { dirname } from "node:path";

import { chatLogPath, createChatLog } from "../src/conversation/chat-log.js";
import { ConversationRuntime } from "../src/runtime/conversation-runtime.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

describe("ConversationRuntime", () => {
	it("releases the chat lease when initialization cannot read history", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const channel = { service: "web", scope: "web", channelId: "owner" } as const;
		const chatPath = chatLogPath(config, channel);
		await mkdir(dirname(chatPath), { recursive: true });
		await writeFile(chatPath, "{invalid json\n", "utf8");

		await assert.rejects(
			ConversationRuntime.connect({
				channelKey: "web-web-owner",
				log: createChatLog(config, channel),
				ownerId: "owner",
			}),
		);

		await writeFile(chatPath, "", "utf8");
		const runtime = await ConversationRuntime.connect({
			channelKey: "web-web-owner",
			log: createChatLog(config, channel),
			ownerId: "owner",
		});
		t.after(() => runtime.disconnect());
	});

	it("renders prompt timestamps in local time while preserving stored UTC timestamps", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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
				bookId: "aaaaaaaaaa",
				remoteTimestamp: "2026-05-09T03:34:16.881Z",
			});

			assert.equal(record.ts, "2026-05-09T03:34:16.881Z");
			assert.equal(record.bookId, "aaaaaaaaaa");
			const prompt = runtime.buildSteerPromptForRecord(record);
			assert.match(prompt, / @ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT[+-]\d{1,2}/);
			assert.doesNotMatch(prompt, /2026-05-09T03:34:16\.881Z/);
		} finally {
			await runtime.disconnect();
		}
	});

	it("keeps prompt metadata out of the ambient query", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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
				text: "mornig",
				remoteTimestamp: "2026-05-09T03:34:16.881Z",
			});

			const dispatch = runtime.beginNextJob();
			assert.ok(dispatch);
			assert.match(dispatch.prompt, /\[qearlyao uid:owner @ .+\] mornig/);
			assert.equal(runtime.ambientQueryForActiveJob(dispatch.job.jobId), "mornig");
		} finally {
			await runtime.disconnect();
		}
	});

	it("includes derived attachment text once in prompt records", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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
			const dispatch = runtime.beginNextJob();
			assert.ok(dispatch);
			assert.equal(runtime.ambientQueryForActiveJob(dispatch.job.jobId), "Hello, can you hear me?");
		} finally {
			await runtime.disconnect();
		}
	});

	it("does not redispatch a job with a durable outbound but missing job_completed", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const channel = { service: "web", scope: "web", channelId: "owner" } as const;
		const runtime = await ConversationRuntime.connect({
			channelKey: "web-web-owner",
			log: createChatLog(config, channel),
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
			const dispatch = runtime.beginNextJob();
			assert.ok(dispatch);
			await runtime.noteOutbound({
				text: "hi",
				messageIds: ["message-2"],
				jobId: dispatch.job.jobId,
			});
		} finally {
			await runtime.disconnect();
		}

		const recovered = await ConversationRuntime.connect({
			channelKey: "web-web-owner",
			log: createChatLog(config, channel),
			ownerId: "owner",
		});
		try {
			assert.equal(recovered.beginNextJob(), undefined);
			await recovered.armAfterCurrentTail();
			await recovered.ingestInbound({
				messageId: "message-3",
				authorId: "owner",
				authorName: "qearlyao",
				text: "next",
				remoteTimestamp: "2026-05-09T03:35:16.881Z",
			});
			const next = recovered.beginNextJob();
			assert.ok(next);
			assert.match(next.prompt, /next/);
			assert.doesNotMatch(next.prompt, /hello/);
		} finally {
			await recovered.disconnect();
		}
	});

	it("keeps retry targets available after a failed manual retry", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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
			const dispatch = runtime.beginNextJob();
			assert.ok(dispatch);
			await runtime.noteOutbound({
				text: "Model error: 400 Bad Request",
				messageIds: ["assistant-error"],
				webMessageId: "assistant-error",
				jobId: dispatch.job.jobId,
			});

			assert.deepEqual(runtime.latestAssistantRetryTarget(), {
				messageId: "assistant-error",
				triggerRecordId: dispatch.job.triggerRecordId,
				attachments: [],
			});

			await runtime.noteAssistantRetry({
				oldMessageId: "assistant-error",
				newMessageId: "assistant-error-retry",
				jobId: "retry-job",
				triggerRecordId: dispatch.job.triggerRecordId,
			});
			await runtime.noteOutbound({
				text: "Model error: 400 Bad Request",
				messageIds: ["assistant-error-retry"],
				webMessageId: "assistant-error-retry",
				jobId: "retry-job",
			});

			assert.deepEqual(runtime.latestAssistantRetryTarget(), {
				messageId: "assistant-error-retry",
				triggerRecordId: dispatch.job.triggerRecordId,
				attachments: [],
			});
		} finally {
			await runtime.disconnect();
		}
	});

	it("only exposes editable assistant targets when the latest reply has text", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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
			const dispatch = runtime.beginNextJob();
			assert.ok(dispatch);
			await runtime.noteOutbound({
				text: "hi",
				messageIds: ["assistant-text"],
				webMessageId: "assistant-text",
				jobId: dispatch.job.jobId,
			});

			assert.deepEqual(runtime.latestAssistantEditTarget(), { messageId: "assistant-text" });

			await runtime.noteOutbound({
				text: "",
				messageIds: ["assistant-silent"],
				webMessageId: "assistant-silent",
				jobId: "silent-job",
				silent: true,
			});

			assert.equal(runtime.latestAssistantEditTarget(), undefined);
			assert.deepEqual(runtime.latestAssistantDeleteTarget(), { messageId: "assistant-silent" });
		} finally {
			await runtime.disconnect();
		}
	});

	it("targets streamed assistant turns that end with an error", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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
			const dispatch = runtime.beginNextJob();
			assert.ok(dispatch);
			await runtime.noteAgentEvent(dispatch.job.jobId, "assistant-streamed", {
				type: "message_start",
				role: "assistant",
			});
			await runtime.noteAgentEvent(dispatch.job.jobId, "assistant-streamed", {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "partial reply" },
			});
			await runtime.noteAgentEvent(dispatch.job.jobId, "assistant-streamed", {
				type: "message_end",
				role: "assistant",
				errorMessage: "503 Service Unavailable",
			});

			assert.deepEqual(runtime.latestAssistantDeleteTarget(), { messageId: "assistant-streamed" });
			assert.deepEqual(runtime.latestAssistantEditTarget(), { messageId: "assistant-streamed" });
			assert.deepEqual(runtime.latestAssistantRetryTarget(), {
				messageId: "assistant-streamed",
				triggerRecordId: dispatch.job.triggerRecordId,
				attachments: [],
			});
		} finally {
			await runtime.disconnect();
		}
	});

	it("does not expose streamed silent replies as editable", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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
			const dispatch = runtime.beginNextJob();
			assert.ok(dispatch);
			await runtime.noteAgentEvent(dispatch.job.jobId, "assistant-silent-streamed", {
				type: "message_start",
				role: "assistant",
			});
			await runtime.noteAgentEvent(dispatch.job.jobId, "assistant-silent-streamed", {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "[[FAMILIAR_SILENT]]\ninternal note" },
			});
			await runtime.noteAgentEvent(dispatch.job.jobId, "assistant-silent-streamed", {
				type: "message_end",
				role: "assistant",
			});
			await runtime.noteOutbound({
				text: "",
				messageIds: ["assistant-silent-streamed"],
				webMessageId: "assistant-silent-streamed",
				jobId: dispatch.job.jobId,
				silent: true,
			});

			assert.equal(runtime.latestAssistantEditTarget(), undefined);
			assert.deepEqual(runtime.latestAssistantDeleteTarget(), { messageId: "assistant-silent-streamed" });
		} finally {
			await runtime.disconnect();
		}
	});

	it("tracks last heartbeat-reset interaction from owner inbound records only", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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

	it("parses reload and restart as owner-only control commands", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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

	it("interruptWork drops queued work without a reset marker; resetConversation writes one", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const runtime = await ConversationRuntime.connect({
			channelKey: "web-web-owner",
			log: createChatLog(config, { service: "web", scope: "web", channelId: "owner" }),
			ownerId: "owner",
		});

		try {
			await runtime.armAfterCurrentTail();
			await runtime.ingestInbound({ messageId: "m1", authorId: "owner", text: "hello" });
			assert.equal(runtime.hasLiveWork(), true);

			const recordsBeforeStop = runtime.getRecords().length;
			runtime.interruptWork();
			assert.equal(runtime.hasLiveWork(), false);
			// History is preserved — the conversation can continue later.
			assert.equal(runtime.getRecords().length, recordsBeforeStop);
			assert.equal(
				runtime
					.getRecords()
					.filter((record) => record.type === "runtime" && record.event === "reset").length,
				0,
				"stop must not write a reset marker",
			);

			await runtime.resetConversation("new conversation requested");
			// reset writes a boundary marker but leaves the runtime history intact for
			// the web UI; only the agent transcript is actually clipped.
			assert.equal(
				runtime
					.getRecords()
					.filter((record) => record.type === "runtime" && record.event === "reset").length,
				1,
			);
			assert.equal(runtime.getRecords().length, recordsBeforeStop + 1);
		} finally {
			await runtime.disconnect();
		}
	});
});
