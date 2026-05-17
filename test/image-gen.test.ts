import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import type { AssistantImages, ImagesContext, ImagesModel } from "@earendil-works/pi-ai";
import sharp from "sharp";

import type { StoredAttachment } from "../src/chat-log.js";
import { attachmentsDir } from "../src/generated-media.js";
import { createGeneratedMediaSink, generatedAttachmentsDir } from "../src/generated-media.js";
import { createImageGenTool, imageExtension, resolveImageModel } from "../src/image-gen.js";
import { MAX_INLINE_IMAGE_BASE64_BYTES } from "../src/inbound-attachments.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

function toolText(result: Awaited<ReturnType<ReturnType<typeof createImageGenTool>["execute"]>>): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("");
}

function imageResult(output: AssistantImages["output"], overrides: Partial<AssistantImages> = {}): AssistantImages {
	return {
		api: "openrouter-images",
		provider: "custom",
		model: "image-model",
		output,
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

async function noisyPngBytes(size = 1600): Promise<Buffer> {
	const raw = Buffer.alloc(size * size * 3);
	randomFillSync(raw);
	return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

function pngBytes(): Buffer {
	return Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154012a0b0000000049454e44ae426082",
		"hex",
	);
}

describe("image_gen helpers", () => {
	it("maps common image mime types to file extensions", () => {
		assert.equal(imageExtension("image/png"), "png");
		assert.equal(imageExtension("image/jpeg"), "jpg");
		assert.equal(imageExtension("image/webp"), "webp");
		assert.equal(imageExtension("image/gif"), "gif");
		assert.equal(imageExtension("application/octet-stream"), "png");
	});

	it("resolves custom image models through models base URL overrides", async () => {
		const config = await configWithDataDir("/workspace/data", {
			imageGen: { model: "custom/gemini-image" },
			models: {
				baseUrls: { custom: "https://images.example.test/v1" },
				apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
			},
		});

		const model = resolveImageModel(config, { provider: "custom", id: "gemini-image", key: "custom/gemini-image" });

		assert.equal(model.provider, "custom");
		assert.equal(model.id, "gemini-image");
		assert.equal(model.api, "openrouter-images");
		assert.equal(model.baseUrl, "https://images.example.test/v1");
		assert.deepEqual(model.output, ["image", "text"]);
	});
});

describe("image_gen tool", () => {
	it("writes generated images and adds generated attachments", async () => {
		const previousKey = process.env.CUSTOM_IMAGE_KEY;
		process.env.CUSTOM_IMAGE_KEY = "secret";
		try {
			const dataDir = await createTempDataDir();
			const sink = createGeneratedMediaSink();
			let capturedModel: ImagesModel<any> | undefined;
			let capturedContext: ImagesContext | undefined;
			const config = await configWithDataDir(dataDir, {
				imageGen: { model: "custom/gemini-image", timeoutMs: 1234 },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
				},
			});
			const tool = createImageGenTool(config, sink, {
				generateImages: async (model, context, options) => {
					capturedModel = model;
					capturedContext = context;
					assert.equal(options?.apiKey, "secret");
					assert.equal(options?.timeoutMs, 1234);
					return imageResult(
						[
							{ type: "text", text: "Done." },
							{ type: "image", mimeType: "image/png", data: Buffer.from("fake-png").toString("base64") },
						],
						{ provider: model.provider, model: model.id, responseId: "img-1" },
					);
				},
			});

			const result = await tool.execute("call-1", { prompt: "draw a small moon" });
			const attachments = sink.drain();

			assert.equal(capturedModel?.baseUrl, "https://images.example.test/v1");
			assert.deepEqual(capturedContext, { input: [{ type: "text", text: "draw a small moon" }] });
			assert.equal(attachments.length, 1);
			assert.equal(attachments[0]?.kind, "image");
			assert.equal(attachments[0]?.source, "generated");
			assert.equal(attachments[0]?.toolName, "image_gen");
			assert.equal(attachments[0]?.provider, "custom");
			assert.ok(attachments[0]?.localPath?.startsWith(generatedAttachmentsDir(config)));
			assert.equal(await readFile(attachments[0]?.localPath ?? "", "utf8"), "fake-png");
			assert.match(toolText(result), /Done\./);
			assert.match(toolText(result), /Generated image attachment: image_gen_/);
			assert.equal(result.details.responseId, "img-1");
			assert.equal(result.details.attachments[0]?.name, attachments[0]?.name);
		} finally {
			if (previousKey === undefined) delete process.env.CUSTOM_IMAGE_KEY;
			else process.env.CUSTOM_IMAGE_KEY = previousKey;
		}
	});

	it("retries with fallback model when the primary returns no image", async () => {
		const previousPrimary = process.env.PRIMARY_IMAGE_KEY;
		const previousFallback = process.env.FALLBACK_IMAGE_KEY;
		process.env.PRIMARY_IMAGE_KEY = "primary-key";
		process.env.FALLBACK_IMAGE_KEY = "fallback-key";
		try {
			const dataDir = await createTempDataDir();
			const sink = createGeneratedMediaSink();
			const attempted: string[] = [];
			const config = await configWithDataDir(dataDir, {
				imageGen: {
					model: "primary/model-a",
					fallbackModel: "fallback/model-b",
				},
				models: {
					baseUrls: {
						primary: "https://primary.example.test/v1",
						fallback: "https://fallback.example.test/v1",
					},
					apiKeyEnvs: {
						primary: "PRIMARY_IMAGE_KEY",
						fallback: "FALLBACK_IMAGE_KEY",
					},
				},
			});
			const tool = createImageGenTool(config, sink, {
				generateImages: async (model, _context, options) => {
					attempted.push(`${model.provider}/${model.id}:${options?.apiKey}`);
					if (model.provider === "primary") {
						return imageResult([{ type: "text", text: "no image" }], {
							provider: model.provider,
							model: model.id,
						});
					}
					return imageResult([{ type: "image", mimeType: "image/webp", data: Buffer.from("ok").toString("base64") }], {
						provider: model.provider,
						model: model.id,
					});
				},
			});

			const result = await tool.execute("call-1", { prompt: "draw a fallback" });

			assert.deepEqual(attempted, ["primary/model-a:primary-key", "fallback/model-b:fallback-key"]);
			assert.equal(result.details.provider, "fallback");
			assert.equal(result.details.model, "model-b");
			assert.equal(result.details.attempts.length, 2);
			assert.equal(result.details.attempts[0]?.stopReason, "stop");
			assert.equal(result.details.attachments[0]?.name.endsWith(".webp"), true);
		} finally {
			if (previousPrimary === undefined) delete process.env.PRIMARY_IMAGE_KEY;
			else process.env.PRIMARY_IMAGE_KEY = previousPrimary;
			if (previousFallback === undefined) delete process.env.FALLBACK_IMAGE_KEY;
			else process.env.FALLBACK_IMAGE_KEY = previousFallback;
		}
	});

	it("recovers provider text data URLs as generated images", async () => {
		const previousKey = process.env.CUSTOM_IMAGE_KEY;
		process.env.CUSTOM_IMAGE_KEY = "secret";
		try {
			const dataDir = await createTempDataDir();
			const sink = createGeneratedMediaSink();
			const config = await configWithDataDir(dataDir, {
				imageGen: { model: "custom/gpt-image" },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
				},
			});
			const tool = createImageGenTool(config, sink, {
				generateImages: async (model) => {
					return imageResult(
						[
							{
								type: "text",
								text: `data:image/png;base64,${pngBytes().toString("base64")}`,
							},
						],
						{ provider: model.provider, model: model.id },
					);
				},
			});

			const result = await tool.execute("call-1", { prompt: "draw via text data url" });
			const attachments = sink.drain();

			assert.equal(attachments.length, 1);
			assert.equal(attachments[0]?.mimeType, "image/png");
			assert.equal(result.details.attachments[0]?.name, attachments[0]?.name);
			assert.match(toolText(result), /Generated image attachment: image_gen_/);
			assert.doesNotMatch(toolText(result), /data:image/);
		} finally {
			if (previousKey === undefined) delete process.env.CUSTOM_IMAGE_KEY;
			else process.env.CUSTOM_IMAGE_KEY = previousKey;
		}
	});

	it("recovers provider markdown image data URLs as generated images", async () => {
		const previousKey = process.env.CUSTOM_IMAGE_KEY;
		process.env.CUSTOM_IMAGE_KEY = "secret";
		try {
			const dataDir = await createTempDataDir();
			const sink = createGeneratedMediaSink();
			const config = await configWithDataDir(dataDir, {
				imageGen: { model: "custom/gpt-image" },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
				},
			});
			const tool = createImageGenTool(config, sink, {
				generateImages: async (model) => {
					return imageResult(
						[
							{
								type: "text",
								text: `![image](data:image/jpeg;base64,${pngBytes().toString("base64")})`,
							},
						],
						{ provider: model.provider, model: model.id },
					);
				},
			});

			const result = await tool.execute("call-1", { prompt: "draw via markdown image" });
			const attachments = sink.drain();

			assert.equal(attachments.length, 1);
			assert.equal(attachments[0]?.mimeType, "image/png");
			assert.equal(result.details.attachments[0]?.name, attachments[0]?.name);
			assert.match(toolText(result), /Generated image attachment: image_gen_/);
			assert.doesNotMatch(toolText(result), /data:image/);
		} finally {
			if (previousKey === undefined) delete process.env.CUSTOM_IMAGE_KEY;
			else process.env.CUSTOM_IMAGE_KEY = previousKey;
		}
	});

	it("recovers provider raw base64 text as generated images", async () => {
		const previousKey = process.env.CUSTOM_IMAGE_KEY;
		process.env.CUSTOM_IMAGE_KEY = "secret";
		try {
			const dataDir = await createTempDataDir();
			const sink = createGeneratedMediaSink();
			const config = await configWithDataDir(dataDir, {
				imageGen: { model: "custom/gpt-image" },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
				},
			});
			const tool = createImageGenTool(config, sink, {
				generateImages: async (model) => {
					return imageResult([{ type: "text", text: pngBytes().toString("base64") }], {
						provider: model.provider,
						model: model.id,
					});
				},
			});

			const result = await tool.execute("call-1", { prompt: "draw via raw base64" });
			const attachments = sink.drain();

			assert.equal(attachments.length, 1);
			assert.equal(attachments[0]?.mimeType, "image/png");
			assert.equal(result.details.attachments[0]?.name, attachments[0]?.name);
			assert.match(toolText(result), /Generated image attachment: image_gen_/);
			assert.doesNotMatch(toolText(result), /iVBOR/);
		} finally {
			if (previousKey === undefined) delete process.env.CUSTOM_IMAGE_KEY;
			else process.env.CUSTOM_IMAGE_KEY = previousKey;
		}
	});

	it("does not surface long text payloads as no-image errors", async () => {
		const previousKey = process.env.CUSTOM_IMAGE_KEY;
		process.env.CUSTOM_IMAGE_KEY = "secret";
		try {
			const dataDir = await createTempDataDir();
			const config = await configWithDataDir(dataDir, {
				imageGen: { model: "custom/gpt-image" },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
				},
			});
			const longText = "x".repeat(5000);
			const tool = createImageGenTool(config, createGeneratedMediaSink(), {
				generateImages: async (model) => {
					return imageResult([{ type: "text", text: longText }], { provider: model.provider, model: model.id });
				},
			});

			await assert.rejects(() => tool.execute("call-1", { prompt: "draw text only" }), {
				message: "Image generation failed: image generation returned no image output",
			});
		} finally {
			if (previousKey === undefined) delete process.env.CUSTOM_IMAGE_KEY;
			else process.env.CUSTOM_IMAGE_KEY = previousKey;
		}
	});

	it("passes selected reference image attachments into upstream image context", async () => {
		const previousKey = process.env.CUSTOM_IMAGE_KEY;
		process.env.CUSTOM_IMAGE_KEY = "secret";
		try {
			const dataDir = await createTempDataDir();
			const config = await configWithDataDir(dataDir, {
				imageGen: { model: "custom/gemini-image" },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
				},
			});
			const imageDir = resolve(attachmentsDir(config), "inbound", "web");
			await mkdir(imageDir, { recursive: true });
			const imagePath = resolve(imageDir, "moon.png");
			await writeFile(imagePath, "reference-image", "utf8");
			const reference: StoredAttachment = {
				id: "att-1",
				name: "moon.png",
				kind: "image",
				mimeType: "image/png",
				size: 15,
				localPath: imagePath,
				source: "web",
			};
			let capturedContext: ImagesContext | undefined;
			const tool = createImageGenTool(config, createGeneratedMediaSink(), {
				referenceAttachments: () => [reference],
				generateImages: async (model, context) => {
					capturedContext = context;
					return imageResult(
						[{ type: "image", mimeType: "image/png", data: Buffer.from("out").toString("base64") }],
						{ provider: model.provider, model: model.id },
					);
				},
			});

			await tool.execute("call-1", { prompt: "redraw this", referenceImages: ["att-1"] });

			assert.equal(capturedContext?.input[0]?.type, "text");
			assert.deepEqual(capturedContext?.input[1], {
				type: "text",
				text: '<attachment name="moon.png" mime="image/png"></attachment>',
			});
			assert.deepEqual(capturedContext?.input[2], {
				type: "image",
				mimeType: "image/png",
				data: Buffer.from("reference-image").toString("base64"),
			});
		} finally {
			if (previousKey === undefined) delete process.env.CUSTOM_IMAGE_KEY;
			else process.env.CUSTOM_IMAGE_KEY = previousKey;
		}
	});

	it("passes workspace reference image paths into upstream image context", async () => {
		const previousKey = process.env.CUSTOM_IMAGE_KEY;
		process.env.CUSTOM_IMAGE_KEY = "secret";
		try {
			const dataDir = await createTempDataDir();
			const config = await configWithDataDir(dataDir, {
				imageGen: { model: "custom/gemini-image" },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
				},
			});
			const referenceDir = resolve(config.workspacePath, "refs");
			await mkdir(referenceDir, { recursive: true });
			const imagePath = resolve(referenceDir, "moon.png");
			await writeFile(imagePath, "workspace-image", "utf8");
			let capturedContext: ImagesContext | undefined;
			const tool = createImageGenTool(config, createGeneratedMediaSink(), {
				generateImages: async (model, context) => {
					capturedContext = context;
					return imageResult(
						[{ type: "image", mimeType: "image/png", data: Buffer.from("out").toString("base64") }],
						{ provider: model.provider, model: model.id },
					);
				},
			});

			await tool.execute("call-1", { prompt: "redraw this", referenceImages: ["refs/moon.png"] });

			assert.deepEqual(capturedContext?.input[1], {
				type: "text",
				text: '<attachment name="moon.png" mime="image/png"></attachment>',
			});
			assert.deepEqual(capturedContext?.input[2], {
				type: "image",
				mimeType: "image/png",
				data: Buffer.from("workspace-image").toString("base64"),
			});
		} finally {
			if (previousKey === undefined) delete process.env.CUSTOM_IMAGE_KEY;
			else process.env.CUSTOM_IMAGE_KEY = previousKey;
		}
	});

	it("resizes oversized workspace reference images before upstream image context", async () => {
		const previousKey = process.env.CUSTOM_IMAGE_KEY;
		process.env.CUSTOM_IMAGE_KEY = "secret";
		try {
			const dataDir = await createTempDataDir();
			const config = await configWithDataDir(dataDir, {
				imageGen: { model: "custom/gemini-image" },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
				},
			});
			const referenceDir = resolve(config.workspacePath, "refs");
			await mkdir(referenceDir, { recursive: true });
			const imagePath = resolve(referenceDir, "huge.png");
			const largeImage = await noisyPngBytes();
			assert.ok(Buffer.byteLength(largeImage.toString("base64"), "utf8") > MAX_INLINE_IMAGE_BASE64_BYTES);
			await writeFile(imagePath, largeImage);
			let capturedContext: ImagesContext | undefined;
			const tool = createImageGenTool(config, createGeneratedMediaSink(), {
				generateImages: async (model, context) => {
					capturedContext = context;
					return imageResult(
						[{ type: "image", mimeType: "image/png", data: Buffer.from("out").toString("base64") }],
						{ provider: model.provider, model: model.id },
					);
				},
			});

			await tool.execute("call-1", { prompt: "redraw this", referenceImages: ["refs/huge.png"] });

			assert.equal(capturedContext?.input[1]?.type, "text");
			if (capturedContext?.input[1]?.type === "text") {
				assert.match(capturedContext.input[1].text, /huge\.png/);
				assert.match(capturedContext.input[1].text, /Resized image/);
			}
			assert.equal(capturedContext?.input[2]?.type, "image");
			if (capturedContext?.input[2]?.type === "image") {
				assert.equal(capturedContext.input[2].mimeType, "image/webp");
				assert.ok(Buffer.byteLength(capturedContext.input[2].data, "utf8") <= MAX_INLINE_IMAGE_BASE64_BYTES);
			}
		} finally {
			if (previousKey === undefined) delete process.env.CUSTOM_IMAGE_KEY;
			else process.env.CUSTOM_IMAGE_KEY = previousKey;
		}
	});

	it("rejects workspace reference image folders", async () => {
		const previousKey = process.env.CUSTOM_IMAGE_KEY;
		process.env.CUSTOM_IMAGE_KEY = "secret";
		try {
			const dataDir = await createTempDataDir();
			const config = await configWithDataDir(dataDir, {
				imageGen: { model: "custom/gemini-image" },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
				},
			});
			const referenceDir = resolve(config.workspacePath, "refs", "style");
			await mkdir(referenceDir, { recursive: true });
			const tool = createImageGenTool(config, createGeneratedMediaSink(), {
				generateImages: async () => {
					throw new Error("should not call provider");
				},
			});

			await assert.rejects(
				() => tool.execute("call-1", { prompt: "use this style", referenceImages: ["refs/style"] }),
				{
					message: "Reference image path must be a file, not a folder: refs/style",
				},
			);
		} finally {
			if (previousKey === undefined) delete process.env.CUSTOM_IMAGE_KEY;
			else process.env.CUSTOM_IMAGE_KEY = previousKey;
		}
	});

	it("rejects workspace reference image paths outside the workspace", async () => {
		const previousKey = process.env.CUSTOM_IMAGE_KEY;
		process.env.CUSTOM_IMAGE_KEY = "secret";
		try {
			const dataDir = await createTempDataDir();
			const config = await configWithDataDir(dataDir, {
				imageGen: { model: "custom/gemini-image" },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
				},
			});
			const tool = createImageGenTool(config, createGeneratedMediaSink(), {
				generateImages: async () => {
					throw new Error("should not call provider");
				},
			});

			await assert.rejects(
				() => tool.execute("call-1", { prompt: "redraw this", referenceImages: ["../outside.png"] }),
				/must be inside the workspace/,
			);
		} finally {
			if (previousKey === undefined) delete process.env.CUSTOM_IMAGE_KEY;
			else process.env.CUSTOM_IMAGE_KEY = previousKey;
		}
	});

	it("rejects workspace reference image symlinks", async () => {
		const previousKey = process.env.CUSTOM_IMAGE_KEY;
		process.env.CUSTOM_IMAGE_KEY = "secret";
		try {
			const dataDir = await createTempDataDir();
			const config = await configWithDataDir(dataDir, {
				imageGen: { model: "custom/gemini-image" },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
				},
			});
			const referenceDir = resolve(config.workspacePath, "refs");
			await mkdir(referenceDir, { recursive: true });
			const outsidePath = resolve(dataDir, "outside.png");
			await writeFile(outsidePath, "outside", "utf8");
			await symlink(outsidePath, resolve(referenceDir, "link.png"));
			const tool = createImageGenTool(config, createGeneratedMediaSink(), {
				generateImages: async () => {
					throw new Error("should not call provider");
				},
			});

			await assert.rejects(
				() => tool.execute("call-1", { prompt: "redraw this", referenceImages: ["refs/link.png"] }),
				/cannot be a symlink/,
			);
		} finally {
			if (previousKey === undefined) delete process.env.CUSTOM_IMAGE_KEY;
			else process.env.CUSTOM_IMAGE_KEY = previousKey;
		}
	});

	it("fails before calling the provider when the configured API key is missing", async () => {
		const previousKey = process.env.MISSING_IMAGE_KEY;
		delete process.env.MISSING_IMAGE_KEY;
		try {
			const config = await configWithDataDir("/workspace/data", {
				imageGen: { model: "custom/gemini-image" },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "MISSING_IMAGE_KEY" },
				},
			});
			const tool = createImageGenTool(config, createGeneratedMediaSink(), {
				generateImages: async () => {
					throw new Error("should not call provider");
				},
			});

			await assert.rejects(() => tool.execute("call-1", { prompt: "draw" }), /MISSING_IMAGE_KEY/);
		} finally {
			if (previousKey === undefined) delete process.env.MISSING_IMAGE_KEY;
			else process.env.MISSING_IMAGE_KEY = previousKey;
		}
	});

	it("rejects empty prompts", async () => {
		const config = await configWithDataDir("/workspace/data");
		const tool = createImageGenTool(config, createGeneratedMediaSink());

		await assert.rejects(() => tool.execute("call-1", { prompt: "  " }), /prompt is required/);
	});
});
