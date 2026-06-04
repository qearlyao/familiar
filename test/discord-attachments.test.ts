import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { StoredAttachment } from "../src/chat-log.js";
import { buildDiscordAttachmentFiles, postDiscordAttachments } from "../src/discord/send.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

describe("discord attachment payloads", () => {
	it("builds multipart attachment files from stored attachments", async (t) => {
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

		const files = await buildDiscordAttachmentFiles([attachment]);

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

		const files = await buildDiscordAttachmentFiles([attachment]);

		assert.equal(files.length, 0);
	});

	it("posts generated attachments through Discord REST multipart and returns message id", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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
		let capturedSignal: AbortSignal | null | undefined;
		globalThis.fetch = (async (url, init) => {
			capturedUrl = String(url);
			capturedAuthorization = String(new Headers(init?.headers).get("authorization"));
			capturedBody = init?.body as FormData;
			capturedSignal = init?.signal;
			return new Response(JSON.stringify({ id: "discord-file-message" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const botToken = config.discord.token;
			assert.ok(botToken);
			const ids = await postDiscordAttachments(botToken, "channel-1", [attachment]);

			assert.deepEqual(ids, ["discord-file-message"]);
			assert.equal(capturedUrl, "https://discord.com/api/v10/channels/channel-1/messages");
			assert.equal(capturedAuthorization, `Bot ${botToken}`);
			assert.ok(capturedSignal instanceof AbortSignal);
			assert.equal(capturedSignal.aborted, false);
			assert.ok(capturedBody?.get("payload_json"));
			const file = capturedBody?.get("files[0]") as File;
			assert.equal(file.name, "tts_rest.mp3");
			assert.equal(file.type, "audio/mpeg");
			assert.equal(await file.text(), "fake audio");
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	it("attachment message ids are appended to messageIds before persistence", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const attachmentPath = resolve(dataDir, "attachments", "generated", "tts_atom.mp3");
		await mkdir(resolve(dataDir, "attachments", "generated"), { recursive: true });
		await writeFile(attachmentPath, Buffer.from("fake audio"));
		const attachment: StoredAttachment = {
			id: "tts_atom",
			name: "tts_atom.mp3",
			mimeType: "audio/mpeg",
			localPath: attachmentPath,
		};

		const previousFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ id: "attachment-msg-id" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
		try {
			const botToken = config.discord.token;
			assert.ok(botToken);
			const ids = await postDiscordAttachments(botToken, "channel-2", [attachment]);
			// The returned id must be present so callers can include it in messageIds for persistence.
			assert.ok(ids.includes("attachment-msg-id"), "attachment message id must be returned for persistence");
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	it("returns empty array and does not throw when no attachments have a local path", async (t) => {
		const dataDir = await createTempDataDir(t);
		await configWithDataDir(t, dataDir);
		const ids = await postDiscordAttachments("discord-token", "channel-3", []);
		assert.deepEqual(ids, []);
	});
});
