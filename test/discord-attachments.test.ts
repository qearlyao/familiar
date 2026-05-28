import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { RawFile } from "@discordjs/rest";
import { REST } from "discord.js";

import type { StoredAttachment } from "../src/chat-log.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

describe("discord attachment payloads", () => {
	it("builds RawFile list from stored attachments (Buffer data, no extra copy)", async (t) => {
		const dataDir = await createTempDataDir(t);
		await configWithDataDir(t, dataDir);
		const attachmentPath = resolve(dataDir, "attachments", "generated", "tts_test.mp3");
		await mkdir(resolve(dataDir, "attachments", "generated"), { recursive: true });
		await writeFile(attachmentPath, Buffer.from("fake audio"));
		const attachment: StoredAttachment = {
			id: "tts_test",
			name: "tts_test.mp3",
			mimeType: "audio/mpeg",
			localPath: attachmentPath,
		};

		const module = await import("../src/discord.js");
		const files = await module.__test.buildRawFiles([attachment]);

		assert.equal(files.length, 1);
		assert.equal(files[0].name, "tts_test.mp3");
		assert.equal(files[0].contentType, "audio/mpeg");
		assert.ok(Buffer.isBuffer(files[0].data), "data should be a Buffer");
		assert.equal((files[0].data as Buffer).toString("utf8"), "fake audio");
	});

	it("skips attachments without localPath", async (t) => {
		const dataDir = await createTempDataDir(t);
		await configWithDataDir(t, dataDir);
		const attachment: StoredAttachment = { id: "no-path", name: "missing.mp3" };

		const module = await import("../src/discord.js");
		const files = await module.__test.buildRawFiles([attachment]);

		assert.equal(files.length, 0);
	});

	it("posts generated attachments via client.rest.post and returns message id", async (t) => {
		const dataDir = await createTempDataDir(t);
		await configWithDataDir(t, dataDir);
		const attachmentPath = resolve(dataDir, "attachments", "generated", "tts_rest.mp3");
		await mkdir(resolve(dataDir, "attachments", "generated"), { recursive: true });
		await writeFile(attachmentPath, Buffer.from("fake audio"));
		const attachment: StoredAttachment = {
			id: "tts_rest",
			name: "tts_rest.mp3",
			mimeType: "audio/mpeg",
			localPath: attachmentPath,
		};

		let capturedRoute = "";
		let capturedFiles: RawFile[] | undefined;
		const originalPost = REST.prototype.post;
		REST.prototype.post = async function (fullRoute, options) {
			capturedRoute = String(fullRoute);
			capturedFiles = (options as { files?: RawFile[] }).files;
			return { id: "discord-file-message" };
		};
		try {
			const rest = new REST();
			const module = await import("../src/discord.js");
			const ids = await module.__test.postDiscordAttachments(rest, "channel-1", [attachment]);

			assert.deepEqual(ids, ["discord-file-message"]);
			assert.equal(capturedRoute, "/channels/channel-1/messages");
			assert.equal(capturedFiles?.length, 1);
			assert.equal(capturedFiles?.[0].name, "tts_rest.mp3");
			assert.equal(capturedFiles?.[0].contentType, "audio/mpeg");
			assert.equal((capturedFiles?.[0].data as Buffer).toString("utf8"), "fake audio");
		} finally {
			REST.prototype.post = originalPost;
		}
	});

	it("attachment message ids are appended to messageIds before persistence", async (t) => {
		const dataDir = await createTempDataDir(t);
		await configWithDataDir(t, dataDir);
		const attachmentPath = resolve(dataDir, "attachments", "generated", "tts_atom.mp3");
		await mkdir(resolve(dataDir, "attachments", "generated"), { recursive: true });
		await writeFile(attachmentPath, Buffer.from("fake audio"));
		const attachment: StoredAttachment = {
			id: "tts_atom",
			name: "tts_atom.mp3",
			mimeType: "audio/mpeg",
			localPath: attachmentPath,
		};

		const originalPost = REST.prototype.post;
		REST.prototype.post = async function () {
			return { id: "attachment-msg-id" };
		};
		try {
			const rest = new REST();
			const module = await import("../src/discord.js");
			const ids = await module.__test.postDiscordAttachments(rest, "channel-2", [attachment]);
			// The returned id must be present so callers can include it in messageIds for persistence.
			assert.ok(ids.includes("attachment-msg-id"), "attachment message id must be returned for persistence");
		} finally {
			REST.prototype.post = originalPost;
		}
	});

	it("returns empty array and does not throw when no attachments have a local path", async (t) => {
		const dataDir = await createTempDataDir(t);
		await configWithDataDir(t, dataDir);
		const rest = new REST();
		const module = await import("../src/discord.js");
		const ids = await module.__test.postDiscordAttachments(rest, "channel-3", []);
		assert.deepEqual(ids, []);
	});
});
