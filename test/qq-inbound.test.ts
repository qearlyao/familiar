import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OneBotClient } from "../src/qq/onebot.js";
import { isQqRecordRef, parseQqMessageEvent, resolveQqRecord } from "../src/qq/inbound.js";

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

	it("parses record segments with a URL as plain attachments", () => {
		const parsed = parseQqMessageEvent(
			groupEvent({
				message: [{ type: "record", data: { file: "voice.amr", url: "https://example.com/voice.amr" } }],
			}),
			SELF_ID,
		);
		assert.equal(parsed.input.text, "");
		assert.deepEqual(parsed.attachments, [{ url: "https://example.com/voice.amr", name: "voice.amr", source: "qq" }]);
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
		assert.equal(attachment.name, "voice.amr");
		assert.equal(attachment.mimeType, "audio/mpeg");
		assert.equal(attachment.source, "qq");
		assert.equal(attachment.buffer?.toString(), "mp3-bytes");
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

	it("rejects get_record responses with only a server-local path", async () => {
		const client: OneBotClient = {
			async callAction<T>(): Promise<T> {
				return { file: "/srv/data/voice.mp3" } as T;
			},
			stop() {},
		};
		await assert.rejects(resolveQqRecord(client, { kind: "record", file: "voice.amr" }), /no downloadable audio/);
	});
});
