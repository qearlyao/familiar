import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	findEnvKeys,
	generateImages,
	getEnvApiKey,
	getImageModels,
	getImageProviders,
	type AssistantImages,
	type ImagesContext,
	type ImagesFunction,
	type ImagesModel,
} from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

import type { Config, ImageGenApi } from "./config.js";
import type { GeneratedMediaSink } from "./generated-media.js";
import { ensureGeneratedAttachmentsDir } from "./generated-media.js";
import { parseModelRef, type ModelRef } from "./models.js";

const IMAGE_GEN_NOTICE_PREFIX = "Generated image attachment:";
const OPENROUTER_IMAGE_BASE_URL = "https://openrouter.ai/api/v1";

const imageGenSchema = Type.Object(
	{
		prompt: Type.String({ description: "Image generation prompt." }),
	},
	{ additionalProperties: false },
);

type ImageGenToolInput = Static<typeof imageGenSchema>;

interface ImageGenAttachmentDetails {
	id: string;
	name: string;
	localPath: string;
	mimeType: string;
	size: number;
}

interface ImageGenAttemptDetails {
	provider: string;
	model: string;
	api: ImageGenApi;
	baseUrl: string;
	responseId?: string;
	stopReason: AssistantImages["stopReason"];
	errorMessage?: string;
}

interface ImageGenToolDetails {
	provider: string;
	model: string;
	api: ImageGenApi;
	baseUrl: string;
	prompt: string;
	responseId?: string;
	textOutput?: string;
	attachments: ImageGenAttachmentDetails[];
	attempts: ImageGenAttemptDetails[];
}

interface ImageGenDeps {
	generateImages?: ImagesFunction<any, any>;
}

function formatImageGenNotice(name: string): string {
	return `${IMAGE_GEN_NOTICE_PREFIX} ${name}`;
}

export function imageExtension(mimeType: string): string {
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
	if (normalized === "image/webp") return "webp";
	if (normalized === "image/gif") return "gif";
	if (normalized === "image/svg+xml") return "svg";
	return "png";
}

function resolveConfiguredBaseUrl(config: Config, ref: ModelRef, model?: ImagesModel<any>): string | undefined {
	return (
		config.models.baseUrls[ref.key] ??
		config.models.baseUrls[ref.provider] ??
		model?.baseUrl ??
		(ref.provider === "openrouter" ? OPENROUTER_IMAGE_BASE_URL : undefined)
	);
}

function resolveConfiguredApiKeyEnv(config: Config, model: ImagesModel<any>): string | undefined {
	return config.models.apiKeyEnvs[`${model.provider}/${model.id}`] ?? config.models.apiKeyEnvs[model.provider];
}

function findBuiltInImageModel(ref: ModelRef): ImagesModel<any> | undefined {
	if (!getImageProviders().includes(ref.provider as any)) return undefined;
	return (getImageModels(ref.provider as any) as ImagesModel<any>[]).find((model) => model.id === ref.id);
}

export function resolveImageModel(config: Config, ref: ModelRef): ImagesModel<ImageGenApi> {
	const builtIn = findBuiltInImageModel(ref);
	const baseUrl = resolveConfiguredBaseUrl(config, ref, builtIn);
	if (!baseUrl) {
		throw new Error(`Missing image model base URL for ${ref.key}. Set models.base_urls.${ref.provider}.`);
	}
	const model: ImagesModel<ImageGenApi> = builtIn
		? ({ ...builtIn, api: config.imageGen.api, baseUrl } as ImagesModel<ImageGenApi>)
		: {
				id: ref.id,
				name: ref.id,
				api: config.imageGen.api,
				provider: ref.provider,
				baseUrl,
				input: ["text", "image"],
				output: ["image", "text"],
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
			};
	return model;
}

function resolveImageModelApiKey(config: Config, model: ImagesModel<any>): string {
	const configuredEnv = resolveConfiguredApiKeyEnv(config, model);
	if (configuredEnv) {
		const apiKey = process.env[configuredEnv];
		if (!apiKey) throw new Error(`Missing image generation API key env: ${configuredEnv}`);
		return apiKey;
	}
	const apiKey = getEnvApiKey(model.provider);
	if (apiKey) return apiKey;
	const envKeys = findEnvKeys(model.provider);
	const hint = envKeys?.length ? envKeys.join(", ") : `models.api_key_envs.${model.provider}`;
	throw new Error(`Missing image generation API key for ${model.provider}/${model.id}: ${hint}`);
}

function imageResultError(result: AssistantImages): string | undefined {
	if (result.stopReason === "error") return result.errorMessage ?? "image generation failed";
	if (result.stopReason === "aborted") return result.errorMessage ?? "image generation aborted";
	if (!result.output.some((item) => item.type === "image")) return "image generation returned no image output";
	return undefined;
}

function textOutput(result: AssistantImages): string {
	return result.output
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text.trim())
		.filter(Boolean)
		.join("\n");
}

async function writeGeneratedImages(
	config: Config,
	mediaSink: GeneratedMediaSink,
	result: AssistantImages,
): Promise<ImageGenAttachmentDetails[]> {
	const attachmentDir = await ensureGeneratedAttachmentsDir(config);
	const attachments: ImageGenAttachmentDetails[] = [];
	for (const item of result.output) {
		if (item.type !== "image") continue;
		const buffer = Buffer.from(item.data, "base64");
		const extension = imageExtension(item.mimeType);
		const id = `image_gen_${randomUUID()}`;
		const name = `${id}.${extension}`;
		const localPath = resolve(attachmentDir, name);
		await writeFile(localPath, buffer);
		const attachment = {
			id,
			name,
			kind: "image",
			source: "generated",
			mimeType: item.mimeType,
			size: buffer.length,
			localPath,
			provider: result.provider,
			toolName: "image_gen",
		} as const;
		mediaSink.add(attachment);
		attachments.push({
			id,
			name,
			localPath,
			mimeType: item.mimeType,
			size: buffer.length,
		});
	}
	return attachments;
}

async function tryGenerateImages(
	config: Config,
	ref: ModelRef,
	context: ImagesContext,
	signal: AbortSignal | undefined,
	generate: ImagesFunction<any, any>,
): Promise<{ model: ImagesModel<ImageGenApi>; result: AssistantImages }> {
	const model = resolveImageModel(config, ref);
	return {
		model,
		result: await generate(model, context, {
			apiKey: resolveImageModelApiKey(config, model),
			signal,
			timeoutMs: config.imageGen.timeoutMs,
		}),
	};
}

function attemptDetails(model: ImagesModel<ImageGenApi>, result: AssistantImages): ImageGenAttemptDetails {
	return {
		provider: model.provider,
		model: model.id,
		api: model.api,
		baseUrl: model.baseUrl,
		...(result.responseId ? { responseId: result.responseId } : {}),
		stopReason: result.stopReason,
		...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
	};
}

export function createImageGenTool(
	config: Config,
	mediaSink: GeneratedMediaSink,
	deps: ImageGenDeps = {},
): AgentTool<typeof imageGenSchema, ImageGenToolDetails> {
	return {
		name: "image_gen",
		label: "image_gen",
		description:
			"generate an image from a prompt. use for drawing, rendering, visual concepts, edits described in text, or when an image attachment would be more useful than prose. returns generated image attachments.",
		parameters: imageGenSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input: ImageGenToolInput, signal?: AbortSignal) {
			const prompt = input.prompt.trim();
			if (!prompt) throw new Error("image_gen prompt is required.");
			const primaryRef = parseModelRef(config.imageGen.model);
			if (!primaryRef) throw new Error(`Invalid image_gen.model: ${config.imageGen.model}`);
			const fallbackRef = config.imageGen.fallbackModel ? parseModelRef(config.imageGen.fallbackModel) : undefined;
			if (config.imageGen.fallbackModel && !fallbackRef) {
				throw new Error(`Invalid image_gen.fallback_model: ${config.imageGen.fallbackModel}`);
			}

			const generate = deps.generateImages ?? generateImages;
			const context: ImagesContext = { input: [{ type: "text", text: prompt }] };
			const attempts: ImageGenAttemptDetails[] = [];
			let selected: { model: ImagesModel<ImageGenApi>; result: AssistantImages } | undefined;
			let selectedError = "";
			for (const ref of [primaryRef, fallbackRef].filter((ref): ref is ModelRef => !!ref)) {
				const attempt = await tryGenerateImages(config, ref, context, signal, generate);
				attempts.push(attemptDetails(attempt.model, attempt.result));
				const error = imageResultError(attempt.result);
				if (!error) {
					selected = attempt;
					break;
				}
				selectedError = error;
				if (attempt.result.stopReason === "aborted") break;
			}
			if (!selected) throw new Error(`Image generation failed: ${selectedError}`);

			const attachments = await writeGeneratedImages(config, mediaSink, selected.result);
			const notices = attachments.map((attachment) => formatImageGenNotice(attachment.name));
			const sideText = textOutput(selected.result);
			return {
				content: [
					{
						type: "text",
						text: [sideText, ...notices].filter(Boolean).join("\n"),
					},
				],
				details: {
					provider: selected.model.provider,
					model: selected.model.id,
					api: selected.model.api,
					baseUrl: selected.model.baseUrl,
					prompt,
					...(selected.result.responseId ? { responseId: selected.result.responseId } : {}),
					...(sideText ? { textOutput: sideText } : {}),
					attachments,
					attempts,
				},
			};
		},
	};
}
