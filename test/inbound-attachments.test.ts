import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { join, resolve } from "node:path";

import {
	MAX_INBOUND_ATTACHMENTS,
	materializeInboundAttachments,
	promptImagesFromAttachments,
} from "../src/inbound-attachments.js";
import { attachmentsDir } from "../src/generated-media.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

function pngBytes(): Buffer {
	return Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154012a0b0000000049454e44ae426082",
		"hex",
	);
}

describe("inbound attachments", () => {
	it("materializes image attachments with canonical extensions and derived metadata", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir);
		const attachments = await materializeInboundAttachments(config, [
			{
				name: "../photo.exe",
				mimeType: "application/octet-stream",
				buffer: pngBytes(),
				source: "web",
			},
		]);

		assert.equal(attachments.length, 1);
		assert.equal(attachments[0]?.name.endsWith(".png"), true);
		assert.equal(attachments[0]?.kind, "image");
		assert.ok(attachments[0]?.localPath?.startsWith(resolve(attachmentsDir(config), "inbound")));
	});

	it("rejects oversized attachment batches without leaving partial writes", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir);
		await assert.rejects(
			() =>
				materializeInboundAttachments(config, [
					{
						name: "one.bin",
						mimeType: "text/plain",
						buffer: Buffer.alloc(1024, 1),
						source: "web",
					},
					{
						name: "two.bin",
						mimeType: "text/plain",
						buffer: Buffer.alloc(13 * 1024 * 1024, 2),
						source: "web",
					},
				]),
			/Attachment is too large/,
		);
		await assert.rejects(() => stat(join(attachmentsDir(config), "inbound")), /ENOENT/);
	});

	it("limits attachment count", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir);
		await assert.rejects(
			() =>
				materializeInboundAttachments(
					config,
					Array.from({ length: MAX_INBOUND_ATTACHMENTS + 1 }, (_, index) => ({
						name: `one-${index}.txt`,
						buffer: Buffer.from("x"),
						source: "web" as const,
					})),
				),
			/Too many attachments/,
		);
	});

	it("filters non-image attachments out of prompt images", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir);
		const [attachment] = await materializeInboundAttachments(config, [
			{
				name: "photo.png",
				mimeType: "image/png",
				buffer: pngBytes(),
				source: "web",
			},
		]);
		assert.ok(attachment?.localPath);
		const result = await promptImagesFromAttachments([
			{
				...(attachment as NonNullable<typeof attachment>),
				kind: "image",
			},
			{
				id: "2",
				name: "note.txt",
				mimeType: "text/plain",
				kind: "file",
				localPath: "/tmp/note.txt",
			},
		]);

		assert.equal(result.images.length, 1);
		assert.match(result.promptSuffix, /photo\.png/);
	});

	it("preserves derived attachment text during materialization", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir);
		const previousFetch = globalThis.fetch;
		const previousGroq = process.env.GROQ_API_KEY;
		process.env.GROQ_API_KEY = "groq-test";
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ text: "transcribed words" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
		try {
			const attachments = await materializeInboundAttachments(config, [
				{
					name: "clip.mp3",
					mimeType: "audio/mpeg",
					buffer: Buffer.from([0xff, 0xfb, 0x90, 0x64]),
					source: "web",
				},
			]);

			assert.equal(attachments[0]?.derived?.text?.label, "transcription");
			assert.equal(attachments[0]?.derived?.text?.text, "transcribed words");
		} finally {
			globalThis.fetch = previousFetch;
			if (previousGroq === undefined) delete process.env.GROQ_API_KEY;
			else process.env.GROQ_API_KEY = previousGroq;
		}
	});
});
