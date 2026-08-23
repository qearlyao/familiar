import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { ChatChannelRef, StoredAttachment } from "../src/conversation/chat-log.js";
import type { OneBotClient } from "../src/qq/onebot.js";
import { chunkQqText, sendQqMessage } from "../src/qq/send.js";
import { createTempDataDir } from "./helpers.js";

const dmRef: ChatChannelRef = { service: "qq", scope: "dm", channelId: "40004" };
const groupRef: ChatChannelRef = { service: "qq", scope: "channel", channelId: "30003" };

interface SentAction {
	action: string;
	params: Record<string, unknown>;
}

function fakeClient(results: unknown[] = []): { client: OneBotClient; sent: SentAction[] } {
	const sent: SentAction[] = [];
	return {
		sent,
		client: {
			callAction: async <T>(action: string, params: Record<string, unknown> = {}): Promise<T> => {
				sent.push({ action, params });
				const result = results.shift();
				if (result instanceof Error) throw result;
				return (result ?? { message_id: 900 + sent.length }) as T;
			},
			stop: () => {},
		},
	};
}

describe("sendQqMessage", () => {
	it("chunks long text near 3000 chars preferring newline boundaries", () => {
		const paragraph = "a".repeat(2900);
		const chunks = chunkQqText(`${paragraph}\n${"b".repeat(200)}`);
		assert.deepEqual(chunks, [paragraph, "b".repeat(200)]);

		const unbroken = chunkQqText("c".repeat(6100));
		assert.deepEqual(
			unbroken.map((chunk) => chunk.length),
			[3000, 3000, 100],
		);
	});

	it("routes dm to send_private_msg and channel to send_group_msg, collecting message ids", async () => {
		const dm = fakeClient([{ message_id: 1 }]);
		assert.deepEqual(await sendQqMessage(dm.client, dmRef, "hi"), ["1"]);
		assert.deepEqual(dm.sent, [
			{ action: "send_private_msg", params: { user_id: 40004, message: [{ type: "text", data: { text: "hi" } }] } },
		]);

		const group = fakeClient([{ message_id: "2" }]);
		assert.deepEqual(await sendQqMessage(group.client, groupRef, "hey"), ["2"]);
		assert.equal(group.sent[0]?.action, "send_group_msg");
		assert.equal(group.sent[0]?.params.group_id, 30003);
	});

	it("attaches image and audio attachments as segments on the last chunk", async (t) => {
		const dir = await createTempDataDir(t);
		const imagePath = resolve(dir, "pic.png");
		await writeFile(imagePath, Buffer.from("png-bytes"));
		const attachments: StoredAttachment[] = [
			{ id: "img", name: "pic.png", kind: "image", localPath: imagePath },
			{ id: "voice", name: "note.mp3", kind: "audio", localPath: imagePath },
		];
		const { client, sent } = fakeClient();
		await sendQqMessage(client, dmRef, "看图", attachments);
		const message = sent[0]?.params.message as Array<{ type: string; data: Record<string, string> }>;
		assert.deepEqual(
			message.map((segment) => segment.type),
			["text", "image", "record"],
		);
		assert.equal(message[1]?.data.file, `base64://${Buffer.from("png-bytes").toString("base64")}`);
		assert.equal(message[2]?.data.file, `base64://${Buffer.from("png-bytes").toString("base64")}`);
	});

	it("sends an image-only message for silent replies and nothing when there is nothing to send", async (t) => {
		const dir = await createTempDataDir(t);
		const imagePath = resolve(dir, "pic.png");
		await writeFile(imagePath, Buffer.from("x"));
		const withImage = fakeClient([{ message_id: 5 }]);
		assert.deepEqual(
			await sendQqMessage(withImage.client, dmRef, "", [{ id: "i", name: "pic.png", kind: "image", localPath: imagePath }]),
			["5"],
		);
		assert.equal((withImage.sent[0]?.params.message as unknown[]).length, 1);

		const empty = fakeClient();
		assert.deepEqual(await sendQqMessage(empty.client, dmRef, ""), []);
		assert.equal(empty.sent.length, 0);
	});

	it("propagates action errors raw", async () => {
		const { client } = fakeClient([new Error("OneBot send_private_msg failed: retcode 1200")]);
		await assert.rejects(sendQqMessage(client, dmRef, "hi"), /retcode 1200/);
	});
});
