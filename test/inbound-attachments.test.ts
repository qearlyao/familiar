import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { join, resolve } from "node:path";

import sharp from "sharp";

import {
	MAX_INBOUND_ATTACHMENTS,
	MAX_INLINE_IMAGE_BASE64_BYTES,
	materializeInboundAttachments,
	promptAttachmentNotes,
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

function mp4Bytes(): Buffer {
	return Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from("ftypmp42", "ascii"), Buffer.alloc(16)]);
}

async function noisyPngBytes(size = 1600): Promise<Buffer> {
	const raw = Buffer.alloc(size * size * 3);
	randomFillSync(raw);
	return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

describe("inbound attachments", () => {
	it("materializes image attachments with canonical extensions and derived metadata", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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

	it("rejects oversized attachment batches without leaving partial writes", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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

	it("limits attachment count", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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

	it("materializes UTF-8 text attachments without ASCII-only sniffing", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const [attachment] = await materializeInboundAttachments(config, [
			{
				name: "message.txt",
				mimeType: "application/octet-stream",
				buffer: Buffer.from("任务风险感知 -> AI建议暴露 -> 信任形成", "utf8"),
				source: "discord",
			},
		]);

		assert.equal(attachment?.name, "message.txt");
		assert.equal(attachment?.kind, "file");
		assert.equal(attachment?.mimeType, "text/plain");
		assert.ok(attachment?.localPath?.startsWith(resolve(attachmentsDir(config), "inbound", "discord")));
	});

	it("filters non-image attachments out of prompt images", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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

	it("includes local paths and text previews in attachment prompt notes", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const [attachment] = await materializeInboundAttachments(config, [
			{
				name: "message.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("first line\nsecond line\nthird line", "utf8"),
				source: "web",
			},
		]);
		assert.ok(attachment?.localPath);

		const notes = promptAttachmentNotes([attachment as NonNullable<typeof attachment>]);

		assert.match(notes, /name="message\.txt"/);
		assert.match(notes, /path="/);
		assert.match(notes, /first line\nsecond line/);
		assert.doesNotMatch(notes, /third line/);
		assert.match(notes, /\[preview:/);
	});

	it("creates and inlines resized image derivatives for oversized images", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const largeImage = await noisyPngBytes();
		assert.ok(Buffer.byteLength(largeImage.toString("base64"), "utf8") > MAX_INLINE_IMAGE_BASE64_BYTES);

		const [attachment] = await materializeInboundAttachments(config, [
			{
				name: "huge.png",
				mimeType: "image/png",
				buffer: largeImage,
				source: "web",
			},
		]);

		assert.equal(attachment?.derived?.image?.mimeType, "image/webp");
		assert.ok(attachment?.derived?.image?.localPath?.startsWith(resolve(attachmentsDir(config), "derived", "image")));
		assert.ok((attachment?.derived?.image?.size ?? 0) < largeImage.length);
		assert.ok((attachment?.derived?.image?.width ?? 0) <= 1600);
		assert.ok((attachment?.derived?.image?.height ?? 0) <= 1600);

		const result = await promptImagesFromAttachments([attachment as NonNullable<typeof attachment>]);

		assert.equal(result.images.length, 1);
		assert.equal(result.images[0]?.mimeType, "image/webp");
		assert.ok(Buffer.byteLength(result.images[0]?.data ?? "", "utf8") <= MAX_INLINE_IMAGE_BASE64_BYTES);
		assert.match(result.promptSuffix, /Resized image/);
		assert.doesNotMatch(result.promptSuffix, /Image omitted/);
	});

	it("preserves derived attachment text during materialization", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
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

	it("summarizes video attachments through the configured Gemini base URL", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			models: {
				baseUrls: { google: "https://example.test/v1beta" },
			},
		});
		const previousFetch = globalThis.fetch;
		const previousGemini = process.env.GEMINI_API_KEY;
		const requestedUrls: string[] = [];
		process.env.GEMINI_API_KEY = "gemini-test";
		globalThis.fetch = (async (input) => {
			requestedUrls.push(String(input));
			return new Response(
				JSON.stringify({
					candidates: [
						{
							content: { parts: [{ text: "A short clip with visible motion." }] },
							finishReason: "STOP",
							index: 0,
						},
					],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}) as typeof fetch;
		try {
			const attachments = await materializeInboundAttachments(config, [
				{
					name: "clip.mp4",
					mimeType: "video/mp4",
					buffer: mp4Bytes(),
					source: "web",
				},
			]);

			assert.equal(attachments[0]?.derived?.text?.label, "summary");
			assert.equal(attachments[0]?.derived?.text?.text, "A short clip with visible motion.");
			assert.equal(requestedUrls.length, 1);
			assert.match(
				requestedUrls[0] ?? "",
				/^https:\/\/example\.test\/v1beta\/models\/gemini-3-flash-preview:generateContent/,
			);
		} finally {
			globalThis.fetch = previousFetch;
			if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
			else process.env.GEMINI_API_KEY = previousGemini;
		}
	});
});
