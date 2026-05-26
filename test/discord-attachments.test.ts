import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { StoredAttachment } from "../src/chat-log.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

describe("discord attachment payloads", () => {
	it("can resolve generated attachments without using local path strings", async (t) => {
		const dataDir = await createTempDataDir();
		t.after(() => rm(dataDir, { recursive: true, force: true }));
		const config = await configWithDataDir(dataDir);
		const attachmentPath = resolve(dataDir, "attachments", "generated", "tts_test.mp3");
		await mkdir(resolve(dataDir, "attachments", "generated"), { recursive: true });
		await writeFile(attachmentPath, Buffer.from("fake audio"));
		const attachment: StoredAttachment = {
			id: "tts_test",
			name: "tts_test.mp3",
			localPath: attachmentPath,
		};

		const module = await import("../src/discord.js");
		const payload = await module.__test.discordAttachmentPayloads([attachment]);

		assert.equal(payload.length, 1);
		assert.equal(payload[0].name, "tts_test.mp3");
		assert.ok(payload[0].bytes instanceof Uint8Array);
		assert.equal(Buffer.from(payload[0].bytes).toString("utf8"), "fake audio");
		void config;
	});

	it("bounds Discord attachment send hangs", async () => {
		const module = await import("../src/discord.js");

		await assert.rejects(
			module.__test.withDiscordSendTimeout(new Promise(() => undefined), "test attachment send", 1),
			/timed out after 1ms/,
		);
	});

	it("posts generated attachments through Discord REST multipart", async (t) => {
		const dataDir = await createTempDataDir();
		t.after(() => rm(dataDir, { recursive: true, force: true }));
		const config = await configWithDataDir(dataDir);
		const attachmentPath = resolve(dataDir, "attachments", "generated", "tts_rest.mp3");
		await mkdir(resolve(dataDir, "attachments", "generated"), { recursive: true });
		await writeFile(attachmentPath, Buffer.from("fake audio"));
		const attachment: StoredAttachment = {
			id: "tts_rest",
			name: "tts_rest.mp3",
			mimeType: "audio/mpeg",
			localPath: attachmentPath,
		};
		const previousFetch = globalThis.fetch;
		let capturedUrl = "";
		let capturedAuthorization = "";
		let capturedBody: FormData | undefined;
		globalThis.fetch = (async (url, init) => {
			capturedUrl = String(url);
			capturedAuthorization = String(new Headers(init?.headers).get("authorization"));
			capturedBody = init?.body as FormData;
			return new Response(JSON.stringify({ id: "discord-file-message" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const module = await import("../src/discord.js");
			const ids = await module.__test.postDiscordAttachments(config, "channel-1", [attachment]);

			assert.deepEqual(ids, ["discord-file-message"]);
			assert.equal(capturedUrl, "https://discord.com/api/v10/channels/channel-1/messages");
			assert.equal(capturedAuthorization, `Bot ${config.discord.token}`);
			assert.ok(capturedBody?.get("payload_json"));
			const file = capturedBody?.get("files[0]") as File;
			assert.equal(file.name, "tts_rest.mp3");
			assert.equal(file.type, "audio/mpeg");
			assert.equal(await file.text(), "fake audio");
		} finally {
			globalThis.fetch = previousFetch;
		}
	});
});
