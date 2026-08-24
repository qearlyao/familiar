import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { OneBotClient } from "../src/qq/onebot.js";
import { isQqRecordRef, parseQqMessageEvent, resolveQqQuote, resolveQqRecord } from "../src/qq/inbound.js";
import type { ChatLogRecord } from "../src/conversation/chat-log.js";
import { createTempDataDir } from "./helpers.js";

const SELF_ID = "10001";

function groupEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		post_type: "message",
		message_type: "group",
		message_id: 5001,
		user_id: 20002,
		group_id: 30003,
		self_id: 10001,
		time: 1_755_600_000,
		sender: { user_id: 20002, nickname: "nick", card: "群名片" },
		message: [],
		...overrides,
	};
}

describe("parseQqMessageEvent", () => {
	it("parses mixed text/at/image segments with mention detection and at stripping", () => {
		const parsed = parseQqMessageEvent(
			groupEvent({
				message: [
					{ type: "at", data: { qq: "10001" } },
					{ type: "text", data: { text: " 看看这个 " } },
					{ type: "at", data: { qq: "77777" } },
					{ type: "image", data: { file: "a.png", url: "https://example.com/a.png" } },
					{ type: "face", data: { id: "1" } },
				],
			}),
			SELF_ID,
		);
		assert.equal(parsed.messageType, "group");
		assert.equal(parsed.channelId, "30003");
		assert.equal(parsed.input.text, "看看这个 @77777[face]");
		assert.equal(parsed.input.mentionedBot, true);
		assert.equal(parsed.input.isBot, false);
		assert.equal(parsed.input.messageId, "5001");
		assert.equal(parsed.input.authorId, "20002");
		assert.equal(parsed.input.remoteTimestamp, new Date(1_755_600_000 * 1000).toISOString());
		assert.deepEqual(parsed.attachments, [{ url: "https://example.com/a.png", name: "a.png", source: "qq" }]);
	});

	it("prefers sender.card over nickname and falls back when card is empty", () => {
		assert.equal(parseQqMessageEvent(groupEvent(), SELF_ID).input.authorName, "群名片");
		const noCard = groupEvent({ sender: { user_id: 20002, nickname: "nick", card: " " } });
		assert.equal(parseQqMessageEvent(noCard, SELF_ID).input.authorName, "nick");
	});

	it("maps private messages to the sender's channel and never flags mentions for other ats", () => {
		const parsed = parseQqMessageEvent(
			{
				post_type: "message",
				message_type: "private",
				message_id: 7,
				user_id: 40004,
				self_id: 10001,
				time: 1_755_600_000,
				sender: { user_id: 40004, nickname: "owner" },
				message: [{ type: "text", data: { text: "hi" } }],
			},
			SELF_ID,
		);
		assert.equal(parsed.messageType, "private");
		assert.equal(parsed.channelId, "40004");
		assert.equal(parsed.input.mentionedBot, false);
	});

	it("rejects non-array message payloads with a pointer at messagePostFormat", () => {
		assert.throws(() => parseQqMessageEvent(groupEvent({ message: "[CQ:at,qq=10001] hi" }), SELF_ID), /messagePostFormat/);
	});

	it("rejects unsupported message types", () => {
		assert.throws(() => parseQqMessageEvent(groupEvent({ message_type: "guild" }), SELF_ID), /message_type/);
	});

	it("routes record segments through get_record whenever a file identifier is present, even with a URL", () => {
		const parsed = parseQqMessageEvent(
			groupEvent({
				message: [{ type: "record", data: { file: "voice.amr", url: "https://example.com/voice.amr" } }],
			}),
			SELF_ID,
		);
		assert.equal(parsed.input.text, "");
		const [attachment] = parsed.attachments;
		assert.ok(attachment && isQqRecordRef(attachment));
		assert.equal(attachment.file, "voice.amr");
	});

	it("uses a record segment's URL directly only when there is no file identifier", () => {
		const parsed = parseQqMessageEvent(
			groupEvent({
				message: [{ type: "record", data: { url: "https://example.com/voice.amr" } }],
			}),
			SELF_ID,
		);
		assert.equal(parsed.input.text, "");
		assert.deepEqual(parsed.attachments, [{ url: "https://example.com/voice.amr", name: undefined, source: "qq" }]);
	});

	it("falls back to get_record when a record URL isn't fetchable over http(s)", () => {
		const parsed = parseQqMessageEvent(
			groupEvent({
				message: [{ type: "record", data: { file: "voice.amr", url: "file:///srv/data/voice.amr" } }],
			}),
			SELF_ID,
		);
		assert.equal(parsed.input.text, "");
		const [attachment] = parsed.attachments;
		assert.ok(attachment && isQqRecordRef(attachment));
		assert.equal(attachment.file, "voice.amr");
	});

	it("parses record segments without a URL as record refs for the daemon to resolve", () => {
		const parsed = parseQqMessageEvent(
			groupEvent({ message: [{ type: "record", data: { file: "voice.amr" } }] }),
			SELF_ID,
		);
		assert.equal(parsed.input.text, "");
		assert.equal(parsed.attachments.length, 1);
		const [attachment] = parsed.attachments;
		assert.ok(attachment && isQqRecordRef(attachment));
		assert.equal(attachment.file, "voice.amr");
	});

	it("captures the quoted message id from a reply segment without rendering it into the text", () => {
		const parsed = parseQqMessageEvent(
			groupEvent({
				message: [
					{ type: "reply", data: { id: "4999" } },
					{ type: "text", data: { text: " 同意 " } },
				],
			}),
			SELF_ID,
		);
		assert.equal(parsed.replyToMessageId, "4999");
		assert.equal(parsed.input.text, "同意");
	});

	it("renders a JSON share card as readable text", () => {
		const parsed = parseQqMessageEvent(
			groupEvent({
				message: [
					{
						type: "json",
						data: {
							data: JSON.stringify({
								prompt: "[分享]",
								meta: { news: { title: "Familiar", desc: "A useful assistant", jump_url: "https://example.com" } },
							}),
						},
					},
				],
			}),
			SELF_ID,
		);
		assert.equal(parsed.input.text, "Familiar\nA useful assistant\nhttps://example.com");
	});
});

describe("resolveQqRecord", () => {
	it("decodes base64 get_record responses into an mp3 attachment", async () => {
		const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
		const client: OneBotClient = {
			async callAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
				calls.push({ action, params });
				return { file: `base64://${Buffer.from("mp3-bytes").toString("base64")}` } as T;
			},
			stop() {},
		};
		const attachment = await resolveQqRecord(client, { kind: "record", file: "voice.amr", name: "voice.amr" });
		assert.deepEqual(calls, [{ action: "get_record", params: { file: "voice.amr", out_format: "mp3" } }]);
		assert.equal(attachment.name, "qq-record.mp3");
		assert.equal(attachment.mimeType, "audio/mpeg");
		assert.equal(attachment.source, "qq");
		assert.equal(attachment.buffer?.toString(), "mp3-bytes");
	});

	it("prefers the plain base64 field NapCat returns for converted records", async () => {
		const client: OneBotClient = {
			async callAction<T>(): Promise<T> {
				return { base64: Buffer.from("mp3-bytes").toString("base64"), file: "/.../record.amr.mp3" } as T;
			},
			stop() {},
		};
		const attachment = await resolveQqRecord(client, { kind: "record", file: "voice.amr", name: "voice.amr" });
		assert.equal(attachment.name, "qq-record.mp3");
		assert.equal(attachment.mimeType, "audio/mpeg");
		assert.equal(attachment.source, "qq");
		assert.equal(attachment.buffer?.toString(), "mp3-bytes");
		assert.equal(attachment.url, undefined);
	});

	it("prefers base64 bytes over a url when get_record returns both", async () => {
		const client: OneBotClient = {
			async callAction<T>(): Promise<T> {
				return {
					base64: Buffer.from("mp3-bytes").toString("base64"),
					url: "https://example.com/voice.mp3",
				} as T;
			},
			stop() {},
		};
		const attachment = await resolveQqRecord(client, { kind: "record", file: "voice.amr" });
		assert.equal(attachment.buffer?.toString(), "mp3-bytes");
		assert.equal(attachment.url, undefined);
	});

	it("prefers the url field when get_record returns one", async () => {
		const client: OneBotClient = {
			async callAction<T>(): Promise<T> {
				return { url: "https://example.com/voice.mp3" } as T;
			},
			stop() {},
		};
		const attachment = await resolveQqRecord(client, { kind: "record", file: "voice.amr" });
		assert.equal(attachment.url, "https://example.com/voice.mp3");
		assert.equal(attachment.buffer, undefined);
	});

	it("reads the file when get_record returns a local path on this host", async (t) => {
		const dir = await createTempDataDir(t);
		const path = resolve(dir, "voice.mp3");
		await writeFile(path, "mp3-bytes");
		const client: OneBotClient = {
			async callAction<T>(): Promise<T> {
				return { file: path } as T;
			},
			stop() {},
		};
		const attachment = await resolveQqRecord(client, { kind: "record", file: "voice.amr" });
		assert.equal(attachment.name, "qq-record.mp3");
		assert.equal(attachment.source, "qq");
		assert.equal(attachment.mimeType, "audio/mpeg");
		assert.equal(attachment.buffer?.toString(), "mp3-bytes");
	});

	it("rejects get_record responses with no URL, base64, or local path", async () => {
		const client: OneBotClient = {
			async callAction<T>(): Promise<T> {
				return { file: "file:///srv/data/voice.mp3" } as T;
			},
			stop() {},
		};
		await assert.rejects(resolveQqRecord(client, { kind: "record", file: "voice.amr" }), /no downloadable audio/);
	});
});

describe("resolveQqQuote", () => {
	const records: ChatLogRecord[] = [
		{
			recordId: 1,
			ts: "2026-01-01T00:00:00.000Z",
			service: "qq",
			scope: "channel",
			channelId: "30003",
			type: "outbound",
			messageIds: ["9001"],
			text: "  你之前问过的那张表我已经做好了  ",
		},
	];

	function fakeClient(response: unknown): OneBotClient {
		return {
			async callAction<T>(): Promise<T> {
				return response as T;
			},
			stop() {},
		};
	}

	it("resolves quotes of the bot's own messages from the local chat log without get_msg", async () => {
		const client = fakeClient({ message: [] });
		assert.equal(await resolveQqQuote(client, "9001", records), "你之前问过的那张表我已经做好了");
	});

	it("falls back to get_msg for messages not in the local log and keeps only text segments", async () => {
		const client = fakeClient({
			message: [
				{ type: "text", data: { text: "前置上下文" } },
				{ type: "image", data: { file: "a.png", url: "https://example.com/a.png" } },
				{ type: "text", data: { text: "后半句" } },
			],
		});
		assert.equal(await resolveQqQuote(client, "7777", records), "前置上下文后半句");
	});

	it("truncates long quotes at the configured cap with an ellipsis", async () => {
		const long = "x".repeat(400);
		const client = fakeClient({ message: [{ type: "text", data: { text: long } }] });
		const resolved = await resolveQqQuote(client, "7777", records);
		assert.equal(resolved, `${"x".repeat(300)}…`);
	});

	it("returns undefined for attachment-only quotes and get_msg failures", async () => {
		assert.equal(await resolveQqQuote(fakeClient({ message: [{ type: "image", data: { file: "a.png" } }] }), "7777", records), undefined);
		assert.equal(await resolveQqQuote(fakeClient(new Error("get_msg unsupported")), "7777", records), undefined);
	});
});
