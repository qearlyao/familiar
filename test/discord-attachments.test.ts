import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { StoredAttachment } from "../src/chat-log.js";
import { configWithDataDir } from "./helpers.js";

describe("discord attachment payloads", () => {
	it("can resolve generated attachments without using local path strings", async () => {
		const dataDir = resolve("/tmp", "familiar-discord-test");
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
		assert.ok(Buffer.isBuffer(payload[0].attachment));
		assert.equal(payload[0].attachment.toString("utf8"), "fake audio");
		void config;
	});

	it("bounds Discord attachment send hangs", async () => {
		const module = await import("../src/discord.js");

		await assert.rejects(
			module.__test.withDiscordSendTimeout(new Promise(() => undefined), "test attachment send", 1),
			/timed out after 1ms/,
		);
	});
});
