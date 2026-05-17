import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import type { AssistantImages, ImagesContext, ImagesModel } from "@earendil-works/pi-ai";

import { createGeneratedMediaSink, generatedAttachmentsDir } from "../src/generated-media.js";
import { createImageGenTool, imageExtension, resolveImageModel } from "../src/image-gen.js";
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
