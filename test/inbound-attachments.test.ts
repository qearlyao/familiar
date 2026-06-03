import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { join, resolve } from "node:path";

import {
	MAX_INBOUND_ATTACHMENTS,
	MAX_INLINE_IMAGE_BASE64_BYTES,
	materializeInboundAttachments,
	promptAttachmentNotes,
	promptImagesFromAttachments,
} from "../src/inbound-attachments.js";
import { attachmentsDir } from "../src/generated-media.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";
import { mp4Bytes, noisyPngBytes, pngBytes } from "./media-fixtures.js";

type GeminiMockFile = {
	name: string;
	uri: string;
	mimeType: string;
	state: "PROCESSING" | "ACTIVE" | "FAILED";
	error?: { message?: string };
};

function geminiVideoFile(state: GeminiMockFile["state"], error?: GeminiMockFile["error"]): GeminiMockFile {
	return {
		name: "files/gemini-video-1",
		uri: "https://generativelanguage.googleapis.com/v1beta/files/gemini-video-1",
		mimeType: "video/mp4",
		state,
		error,
	};
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json");
	return new Response(JSON.stringify(body), { ...init, headers });
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function installGeminiVideoFetchMock(options: {
	requestedUrls: string[];
	generateText?: string;
	startThrows?: Error;
	uploadFile?: GeminiMockFile;
	pollFiles?: GeminiMockFile[];
	pollThrows?: Error;
	deleteStatus?: number;
	deleteThrows?: boolean;
}): typeof fetch {
	const uploadFile = options.uploadFile ?? geminiVideoFile("PROCESSING");
	const pollFiles = [...(options.pollFiles ?? [geminiVideoFile("ACTIVE")])];
	return (async (input, init) => {
		const url = requestUrl(input);
		const method = init?.method ?? "GET";
		options.requestedUrls.push(url);
		if (method === "POST" && url.endsWith("/upload/v1beta/files")) {
			if (options.startThrows) throw options.startThrows;
			return new Response("{}", {
				status: 200,
				headers: { "x-goog-upload-url": "https://upload.example.test/upload-session" },
			});
		}
		if (method === "POST" && url === "https://example.test/upload-session") {
			return jsonResponse(
				{ file: uploadFile },
				{ status: 200, headers: { "x-goog-upload-status": "final" } },
			);
		}
		if (method === "GET" && /\/v1beta\/files\/gemini-video-1$/.test(url)) {
			if (options.pollThrows) throw options.pollThrows;
			return jsonResponse(pollFiles.shift() ?? geminiVideoFile("ACTIVE"));
		}
		if (method === "POST" && /\/v1beta\/models\/gemini-3-flash-preview:generateContent/.test(url)) {
			return jsonResponse({
				candidates: [
					{
						content: { parts: [{ text: options.generateText ?? "A short clip with visible motion." }] },
						finishReason: "STOP",
						index: 0,
					},
				],
			});
		}
		if (method === "DELETE" && /\/v1beta\/files\/gemini-video-1$/.test(url)) {
			if (options.deleteThrows) throw new Error("delete failed");
			return jsonResponse({}, { status: options.deleteStatus ?? 200 });
		}
		throw new Error(`unexpected Gemini request: ${method} ${url}`);
	}) as typeof fetch;
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
						buffer: Buffer.alloc(33 * 1024 * 1024, 2),
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

	it("infers video attachments when browser upload metadata is generic", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		config.mediaUnderstanding.video.apiKeyEnv = "FAMILIAR_TEST_GEMINI_DISABLED";

		const attachments = await materializeInboundAttachments(config, [
			{
				name: "clip.bin",
				mimeType: "application/octet-stream",
				buffer: mp4Bytes(),
				source: "web",
			},
			{
				name: "movie.mov",
				mimeType: "application/octet-stream",
				buffer: Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from("ftypqt  ", "ascii")]),
				source: "web",
			},
			{
				name: "capture.webm",
				mimeType: "application/octet-stream",
				buffer: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(8)]),
				source: "web",
			},
		]);

		assert.deepEqual(
			attachments.map((attachment) => [attachment.name, attachment.kind, attachment.mimeType]),
			[
				["clip.mp4", "video", "video/mp4"],
				["movie.mov", "video", "video/quicktime"],
				["capture.webm", "video", "video/webm"],
			],
		);
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
		globalThis.fetch = installGeminiVideoFetchMock({ requestedUrls });
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
			assert.equal(requestedUrls.some((url) => /^https:\/\/example\.test\/upload\/v1beta\/files/.test(url)), true);
			assert.equal(requestedUrls.includes("https://example.test/upload-session"), true);
			assert.equal(requestedUrls.some((url) => /^https:\/\/example\.test\/v1beta\/files\/gemini-video-1/.test(url)), true);
			assert.equal(
				requestedUrls.some((url) =>
					/^https:\/\/example\.test\/v1beta\/models\/gemini-3-flash-preview:generateContent/.test(url),
				),
				true,
			);
		} finally {
			globalThis.fetch = previousFetch;
			if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
			else process.env.GEMINI_API_KEY = previousGemini;
		}
	});

	it("preserves a prompt-visible note when Gemini video upload times out before creating a file", async (t) => {
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
		globalThis.fetch = installGeminiVideoFetchMock({
			requestedUrls,
			startThrows: new DOMException("The operation timed out.", "TimeoutError"),
		});
		try {
			const attachments = await materializeInboundAttachments(config, [
				{
					name: "clip.mp4",
					mimeType: "video/mp4",
					buffer: mp4Bytes(),
					source: "web",
				},
			]);

			assert.equal(attachments[0]?.derived?.text?.label, "note");
			assert.match(attachments[0]?.derived?.text?.text ?? "", /timed out after 5 minutes/i);
			assert.equal(requestedUrls.some((url) => /\/v1beta\/files\/gemini-video-1/.test(url)), false);
		} finally {
			globalThis.fetch = previousFetch;
			if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
			else process.env.GEMINI_API_KEY = previousGemini;
		}
	});

	it("preserves a prompt-visible note when Gemini video processing times out", async (t) => {
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
		globalThis.fetch = installGeminiVideoFetchMock({
			requestedUrls,
			uploadFile: geminiVideoFile("PROCESSING"),
			pollThrows: new Error("request timed out"),
		});
		try {
			const attachments = await materializeInboundAttachments(config, [
				{
					name: "clip.mp4",
					mimeType: "video/mp4",
					buffer: mp4Bytes(),
					source: "web",
				},
			]);

			assert.equal(attachments[0]?.derived?.text?.label, "note");
			assert.match(attachments[0]?.derived?.text?.text ?? "", /timed out after 5 minutes/i);
			assert.equal(requestedUrls.some((url) => /generateContent/.test(url)), false);
			assert.equal(requestedUrls.some((url) => /\/v1beta\/files\/gemini-video-1/.test(url)), true);
		} finally {
			globalThis.fetch = previousFetch;
			if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
			else process.env.GEMINI_API_KEY = previousGemini;
		}
	});

	it("preserves a prompt-visible note when Gemini video processing fails", async (t) => {
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
		globalThis.fetch = installGeminiVideoFetchMock({
			requestedUrls,
			uploadFile: geminiVideoFile("PROCESSING"),
			pollFiles: [geminiVideoFile("FAILED", { message: "video processing failed" })],
		});
		try {
			const attachments = await materializeInboundAttachments(config, [
				{
					name: "clip.mp4",
					mimeType: "video/mp4",
					buffer: mp4Bytes(),
					source: "web",
				},
			]);

			assert.equal(attachments[0]?.derived?.text?.label, "note");
			assert.match(attachments[0]?.derived?.text?.text ?? "", /failed before a summary/i);
			assert.equal(requestedUrls.some((url) => /generateContent/.test(url)), false);
			assert.equal(requestedUrls.some((url) => /\/v1beta\/files\/gemini-video-1/.test(url)), true);
		} finally {
			globalThis.fetch = previousFetch;
			if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
			else process.env.GEMINI_API_KEY = previousGemini;
		}
	});

	it("keeps a Gemini video summary when cleanup fails", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			models: {
				baseUrls: { google: "https://example.test/v1beta" },
			},
		});
		const previousFetch = globalThis.fetch;
		const previousGemini = process.env.GEMINI_API_KEY;
		const previousWarn = console.warn;
		const requestedUrls: string[] = [];
		process.env.GEMINI_API_KEY = "gemini-test";
		console.warn = () => undefined;
		globalThis.fetch = installGeminiVideoFetchMock({
			requestedUrls,
			generateText: "A summary survives cleanup failure.",
			deleteStatus: 500,
		});
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
			assert.equal(attachments[0]?.derived?.text?.text, "A summary survives cleanup failure.");
			assert.equal(requestedUrls.some((url) => /\/v1beta\/files\/gemini-video-1/.test(url)), true);
		} finally {
			console.warn = previousWarn;
			globalThis.fetch = previousFetch;
			if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
			else process.env.GEMINI_API_KEY = previousGemini;
		}
	});
});
