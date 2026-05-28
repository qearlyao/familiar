import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import type { AssistantImages, ImagesContext, ImagesModel } from "@earendil-works/pi-ai";

import type { StoredAttachment } from "../src/chat-log.js";
import { attachmentsDir } from "../src/generated-media.js";
import { createGeneratedMediaSink, generatedAttachmentsDir } from "../src/generated-media.js";
import { createImageGenTool, imageExtension, resolveImageModel } from "../src/image-gen.js";
import { MAX_INLINE_IMAGE_BASE64_BYTES } from "../src/inbound-attachments.js";
import { configWithDataDir, createTempDataDir, withEnv, withoutEnv } from "./helpers.js";
import { noisyPngBytes, pngBytes } from "./media-fixtures.js";

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

	it("resolves custom image models through models base URL overrides", async (t) => {
		const config = await configWithDataDir(t, "/workspace/data", {
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
	it("writes generated images and adds generated attachments", async (t) => {
		await withEnv("CUSTOM_IMAGE_KEY", "secret", async () => {
			const dataDir = await createTempDataDir(t);
			const sink = createGeneratedMediaSink();
			let capturedModel: ImagesModel<any> | undefined;
			let capturedContext: ImagesContext | undefined;
			const config = await configWithDataDir(t, dataDir, {
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
			assert.deepEqual(Object.keys(result.details).sort(), ["id", "localPath", "model", "stopReason", "textOutput"]);
			assert.equal(result.details.model, "custom/gemini-image");
			assert.equal(result.details.textOutput, "Done.");
			assert.equal(result.details.id, attachments[0]?.id);
			assert.equal(result.details.localPath, attachments[0]?.localPath);
			assert.equal(result.details.stopReason, "stop");
		});
	});

	it("retries with fallback model when the primary returns no image", async (t) => {
		await withEnv("PRIMARY_IMAGE_KEY", "primary-key", () =>
			withEnv("FALLBACK_IMAGE_KEY", "fallback-key", async () => {
				const dataDir = await createTempDataDir(t);
				const sink = createGeneratedMediaSink();
				const attempted: string[] = [];
				const config = await configWithDataDir(t, dataDir, {
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
						attempted.push(`${model.provider}/${model.id}:${options?.apiKey}:${options?.timeoutMs}`);
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
				const attachments = sink.drain();

				assert.deepEqual(attempted, ["primary/model-a:primary-key:120000", "fallback/model-b:fallback-key:120000"]);
				assert.deepEqual(Object.keys(result.details).sort(), ["id", "localPath", "model", "stopReason"]);
				assert.equal(result.details.model, "fallback/model-b");
				assert.equal(result.details.id, attachments[0]?.id);
				assert.equal(result.details.localPath, attachments[0]?.localPath);
				assert.equal(result.details.localPath?.endsWith(".webp"), true);
				assert.equal(result.details.stopReason, "stop");
			}),
		);
	});

	it("recovers provider text data URLs as generated images", async (t) => {
		await withEnv("CUSTOM_IMAGE_KEY", "secret", async () => {
			const dataDir = await createTempDataDir(t);
			const sink = createGeneratedMediaSink();
			const config = await configWithDataDir(t, dataDir, {
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
			assert.equal(result.details.id, attachments[0]?.id);
			assert.equal(result.details.localPath, attachments[0]?.localPath);
			assert.match(toolText(result), /Generated image attachment: image_gen_/);
			assert.doesNotMatch(toolText(result), /data:image/);
		});
	});

	it("recovers provider markdown image data URLs as generated images", async (t) => {
		await withEnv("CUSTOM_IMAGE_KEY", "secret", async () => {
			const dataDir = await createTempDataDir(t);
			const sink = createGeneratedMediaSink();
			const config = await configWithDataDir(t, dataDir, {
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
			assert.equal(result.details.id, attachments[0]?.id);
			assert.equal(result.details.localPath, attachments[0]?.localPath);
			assert.match(toolText(result), /Generated image attachment: image_gen_/);
			assert.doesNotMatch(toolText(result), /data:image/);
		});
	});

	it("recovers provider markdown image URLs as generated images", async (t) => {
		const previousKey = process.env.CUSTOM_IMAGE_KEY;
		const previousFetch = globalThis.fetch;
		process.env.CUSTOM_IMAGE_KEY = "secret";
		try {
			const dataDir = await createTempDataDir(t);
			const sink = createGeneratedMediaSink();
			const imageBytes = pngBytes();
			const fetches: string[] = [];
			globalThis.fetch = (async (input, init) => {
				fetches.push(String(input));
				assert.equal(init?.signal instanceof AbortSignal, true);
				const body = new Uint8Array(imageBytes);
				return new Response(body, { headers: { "content-type": "image/png" } });
			}) as typeof fetch;
			const config = await configWithDataDir(t, dataDir, {
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
								text: "![image](https://oss.filenest.top/uploads/generated.png)\n\n",
							},
						],
						{ provider: model.provider, model: model.id },
					);
				},
			});

			const result = await tool.execute("call-1", { prompt: "draw via markdown image url" }, new AbortController().signal);
			const attachments = sink.drain();

			assert.deepEqual(fetches, ["https://oss.filenest.top/uploads/generated.png"]);
			assert.equal(attachments.length, 1);
			assert.equal(attachments[0]?.mimeType, "image/png");
			assert.equal(result.details.id, attachments[0]?.id);
			assert.equal(result.details.localPath, attachments[0]?.localPath);
			assert.deepEqual(await readFile(attachments[0]?.localPath ?? ""), imageBytes);
			assert.match(toolText(result), /Generated image attachment: image_gen_/);
			assert.doesNotMatch(toolText(result), /oss\.filenest/);
		} finally {
			globalThis.fetch = previousFetch;
			if (previousKey === undefined) delete process.env.CUSTOM_IMAGE_KEY;
			else process.env.CUSTOM_IMAGE_KEY = previousKey;
		}
	});

	it("ignores provider markdown URLs that do not fetch image bytes", async (t) => {
		const previousKey = process.env.CUSTOM_IMAGE_KEY;
		const previousFetch = globalThis.fetch;
		process.env.CUSTOM_IMAGE_KEY = "secret";
		try {
			const dataDir = await createTempDataDir(t);
			globalThis.fetch = (async () => new Response("not an image", { headers: { "content-type": "text/plain" } })) as typeof fetch;
			const config = await configWithDataDir(t, dataDir, {
				imageGen: { model: "custom/gpt-image" },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
				},
			});
			const tool = createImageGenTool(config, createGeneratedMediaSink(), {
				generateImages: async (model) => {
					return imageResult([{ type: "text", text: "![image](https://images.example.test/not-image.png)" }], {
						provider: model.provider,
						model: model.id,
					});
				},
			});

			await assert.rejects(() => tool.execute("call-1", { prompt: "draw invalid remote image" }), {
				message: "Image generation failed: image generation returned no image output",
			});
		} finally {
			globalThis.fetch = previousFetch;
			if (previousKey === undefined) delete process.env.CUSTOM_IMAGE_KEY;
			else process.env.CUSTOM_IMAGE_KEY = previousKey;
		}
	});

	it("rejects provider markdown URLs whose response body exceeds the size cap", async (t) => {
		const previousKey = process.env.CUSTOM_IMAGE_KEY;
		const previousFetch = globalThis.fetch;
		process.env.CUSTOM_IMAGE_KEY = "secret";
		try {
			const dataDir = await createTempDataDir(t);
			globalThis.fetch = (async () =>
				new Response(new Uint8Array(pngBytes()), {
					headers: {
						"content-type": "image/png",
						"content-length": String(20 * 1024 * 1024),
					},
				})) as typeof fetch;
			const config = await configWithDataDir(t, dataDir, {
				imageGen: { model: "custom/gpt-image" },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
				},
			});
			const tool = createImageGenTool(config, createGeneratedMediaSink(), {
				generateImages: async (model) => {
					return imageResult([{ type: "text", text: "![image](https://images.example.test/huge.png)" }], {
						provider: model.provider,
						model: model.id,
					});
				},
			});

			await assert.rejects(() => tool.execute("call-1", { prompt: "draw oversized remote image" }), {
				message: "Image generation failed: image generation returned no image output",
			});
		} finally {
			globalThis.fetch = previousFetch;
			if (previousKey === undefined) delete process.env.CUSTOM_IMAGE_KEY;
			else process.env.CUSTOM_IMAGE_KEY = previousKey;
		}
	});

	it("recovers provider raw base64 text as generated images", async (t) => {
		await withEnv("CUSTOM_IMAGE_KEY", "secret", async () => {
			const dataDir = await createTempDataDir(t);
			const sink = createGeneratedMediaSink();
			const config = await configWithDataDir(t, dataDir, {
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
			assert.equal(result.details.id, attachments[0]?.id);
			assert.equal(result.details.localPath, attachments[0]?.localPath);
			assert.match(toolText(result), /Generated image attachment: image_gen_/);
			assert.doesNotMatch(toolText(result), /iVBOR/);
		});
	});

	it("does not surface long text payloads as no-image errors", async (t) => {
		await withEnv("CUSTOM_IMAGE_KEY", "secret", async () => {
			const dataDir = await createTempDataDir(t);
			const config = await configWithDataDir(t, dataDir, {
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
		});
	});

	it("passes selected reference image attachments into upstream image context", async (t) => {
		await withEnv("CUSTOM_IMAGE_KEY", "secret", async () => {
			const dataDir = await createTempDataDir(t);
			const config = await configWithDataDir(t, dataDir, {
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
		});
	});

	it("passes workspace reference image paths into upstream image context", async (t) => {
		await withEnv("CUSTOM_IMAGE_KEY", "secret", async () => {
			const dataDir = await createTempDataDir(t);
			const config = await configWithDataDir(t, dataDir, {
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
		});
	});

	it("passes ~/ reference image paths into upstream image context", async (t) => {
		await withEnv("CUSTOM_IMAGE_KEY", "secret", async () => {
			const dataDir = await createTempDataDir(t);
			const config = await configWithDataDir(t, dataDir, {
				imageGen: { model: "custom/gemini-image" },
				models: {
					baseUrls: { custom: "https://images.example.test/v1" },
					apiKeyEnvs: { custom: "CUSTOM_IMAGE_KEY" },
				},
			});
			const referenceDir = resolve(homedir(), ".familiar-test-image-gen-refs");
			await mkdir(referenceDir, { recursive: true });
			t.after(async () => {
				const { rm } = await import("node:fs/promises");
				await rm(referenceDir, { recursive: true, force: true });
			});
			const imagePath = resolve(referenceDir, "moon.png");
			await writeFile(imagePath, "home-image", "utf8");
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

			await tool.execute("call-1", {
				prompt: "redraw this",
				referenceImages: ["~/.familiar-test-image-gen-refs/moon.png"],
			});

			assert.deepEqual(capturedContext?.input[1], {
				type: "text",
				text: '<attachment name="moon.png" mime="image/png"></attachment>',
			});
			assert.deepEqual(capturedContext?.input[2], {
				type: "image",
				mimeType: "image/png",
				data: Buffer.from("home-image").toString("base64"),
			});
		});
	});

	it("resizes oversized workspace reference images before upstream image context", async (t) => {
		await withEnv("CUSTOM_IMAGE_KEY", "secret", async () => {
			const dataDir = await createTempDataDir(t);
			const config = await configWithDataDir(t, dataDir, {
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
		});
	});

	it("rejects workspace reference image folders", async (t) => {
		await withEnv("CUSTOM_IMAGE_KEY", "secret", async () => {
			const dataDir = await createTempDataDir(t);
			const config = await configWithDataDir(t, dataDir, {
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
		});
	});

	it("rejects workspace reference image paths outside the workspace", async (t) => {
		await withEnv("CUSTOM_IMAGE_KEY", "secret", async () => {
			const dataDir = await createTempDataDir(t);
			const config = await configWithDataDir(t, dataDir, {
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
		});
	});

	it("rejects workspace reference image symlinks", async (t) => {
		await withEnv("CUSTOM_IMAGE_KEY", "secret", async () => {
			const dataDir = await createTempDataDir(t);
			const config = await configWithDataDir(t, dataDir, {
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
			try {
				await symlink(outsidePath, resolve(referenceDir, "link.png"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EPERM") return;
				throw error;
			}
			const tool = createImageGenTool(config, createGeneratedMediaSink(), {
				generateImages: async () => {
					throw new Error("should not call provider");
				},
			});

			await assert.rejects(
				() => tool.execute("call-1", { prompt: "redraw this", referenceImages: ["refs/link.png"] }),
				/cannot be a symlink/,
			);
		});
	});

	it("fails before calling the provider when the configured API key is missing", async (t) => {
		await withoutEnv("MISSING_IMAGE_KEY", async () => {
			const config = await configWithDataDir(t, "/workspace/data", {
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
		});
	});

	it("rejects empty prompts", async (t) => {
		const config = await configWithDataDir(t, "/workspace/data");
		const tool = createImageGenTool(config, createGeneratedMediaSink());

		await assert.rejects(() => tool.execute("call-1", { prompt: "  " }), /prompt is required/);
	});
});
