import { randomUUID } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantImages,
	findEnvKeys,
	generateImages,
	getEnvApiKey,
	getImageModels,
	getImageProviders,
	type ImagesContext,
	type ImagesFunction,
	type ImagesModel,
} from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

import type { StoredAttachment } from "./chat-log.js";
import type { Config, ImageGenApi } from "./config.js";
import type { GeneratedMediaSink } from "./generated-media.js";
import { ensureGeneratedAttachmentsDir } from "./generated-media.js";
import { ensureInlineImageDerivative } from "./image-derivatives.js";
import { promptImagesFromAttachments } from "./inbound-attachments.js";
import { type ModelRef, parseModelRef } from "./models.js";
import { imageMimeTypeFromPath, sniffImageMimeType } from "./util/image-mime.js";

const IMAGE_GEN_NOTICE_PREFIX = "Generated image attachment:";
const OPENROUTER_IMAGE_BASE_URL = "https://openrouter.ai/api/v1";

const imageGenSchema = Type.Object(
	{
		prompt: Type.String({ description: "Image generation prompt." }),
		referenceImages: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Optional. Image attachment IDs or names, or workspace-relative, absolute, or ~/ image file paths, to use as visual references. Prefer IDs from the attachment tags when available.",
			}),
		),
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
	model: string;
	stopReason: AssistantImages["stopReason"];
	errorMessage?: string;
}

interface ImageGenToolDetails {
	model: string;
	textOutput?: string;
	id?: string;
	localPath?: string;
	stopReason: AssistantImages["stopReason"];
	errorMessage?: string;
}

interface ImageGenDeps {
	generateImages?: ImagesFunction<any, any>;
	referenceAttachments?: () => readonly StoredAttachment[];
}

interface WorkspaceReferenceImage {
	localPath: string;
	name: string;
	mimeType: string;
	size: number;
}

interface RecoveredImage {
	mimeType: string;
	data: string;
}

interface TextImageRecoveryOptions {
	signal?: AbortSignal;
}

const MAX_REMOTE_IMAGE_BYTES = 12 * 1024 * 1024;

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

function recoveredImageFromBase64(value: string): RecoveredImage | undefined {
	const data = value.trim();
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) return undefined;
	const buffer = Buffer.from(data, "base64");
	if (!buffer.length) return undefined;
	const detectedMimeType = sniffImageMimeType(buffer);
	if (!detectedMimeType) return undefined;
	return {
		mimeType: detectedMimeType,
		data,
	};
}

function recoveredInlineImageFromText(text: string): RecoveredImage | undefined {
	const trimmed = text.trim();
	const dataUrlMatch = trimmed.match(/^data:(image\/[^;]+);base64,([A-Za-z0-9+/]+={0,2})$/);
	if (dataUrlMatch) return recoveredImageFromBase64(dataUrlMatch[2] ?? "");
	const embeddedDataUrlMatch = text.match(/data:(image\/[^;)\]\s]+);base64,([A-Za-z0-9+/]+={0,2})/);
	if (embeddedDataUrlMatch) {
		return recoveredImageFromBase64(embeddedDataUrlMatch[2] ?? "");
	}
	return recoveredImageFromBase64(trimmed);
}

function imageUrlFromMarkdownText(text: string): URL | undefined {
	const match = text.match(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/i);
	if (!match?.[1]) return undefined;
	try {
		const url = new URL(match[1]);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		return url;
	} catch {
		return undefined;
	}
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<Buffer | undefined> {
	const reader = response.body?.getReader();
	if (!reader) {
		const buffer = Buffer.from(await response.arrayBuffer());
		return buffer.byteLength > maxBytes ? undefined : buffer;
	}
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = Buffer.from(value);
			total += chunk.byteLength;
			if (total > maxBytes) return undefined;
			chunks.push(chunk);
		}
		return Buffer.concat(chunks);
	} finally {
		reader.releaseLock();
	}
}

async function recoveredImageFromRemoteUrl(
	url: URL,
	options: TextImageRecoveryOptions,
): Promise<RecoveredImage | undefined> {
	try {
		const response = await fetch(url, { signal: options.signal });
		if (!response.ok) return undefined;
		const contentLength = Number(response.headers.get("content-length") ?? 0);
		if (contentLength > MAX_REMOTE_IMAGE_BYTES) return undefined;
		const bytes = await readBoundedResponseBody(response, MAX_REMOTE_IMAGE_BYTES);
		if (!bytes) return undefined;
		const detectedMimeType = sniffImageMimeType(bytes);
		if (!detectedMimeType) return undefined;
		return {
			mimeType: detectedMimeType,
			data: bytes.toString("base64"),
		};
	} catch (error) {
		if (options.signal?.aborted) throw error;
		return undefined;
	}
}

async function recoveredImageFromText(
	text: string,
	options: TextImageRecoveryOptions,
): Promise<RecoveredImage | undefined> {
	const inlineImage = recoveredInlineImageFromText(text);
	if (inlineImage) return inlineImage;
	const url = imageUrlFromMarkdownText(text);
	if (!url) return undefined;
	return recoveredImageFromRemoteUrl(url, options);
}

async function normalizeCompatibleImageText(
	result: AssistantImages,
	options: TextImageRecoveryOptions,
): Promise<AssistantImages> {
	if (result.output.some((item) => item.type === "image")) return result;
	const output: AssistantImages["output"] = [];
	for (const item of result.output) {
		if (item.type !== "text") {
			output.push(item);
			continue;
		}
		const recovered = await recoveredImageFromText(item.text, options);
		if (!recovered) {
			output.push(item);
			continue;
		}
		output.push({ type: "image", mimeType: recovered.mimeType, data: recovered.data });
	}
	if (!output.some((item) => item.type === "image")) return result;
	return { ...result, output };
}

function resolveWorkspaceReferencePath(config: Config, rawRef: string): string {
	if (rawRef === "~" || rawRef.startsWith("~/")) return resolve(homedir(), rawRef.slice(2));
	if (isAbsolute(rawRef)) return resolve(rawRef);
	const path = resolve(config.workspacePath, rawRef);
	const workspaceRelative = relative(config.workspacePath, path);
	if (!workspaceRelative || workspaceRelative.startsWith("..") || isAbsolute(workspaceRelative)) {
		throw new Error(`Reference image path must be inside the workspace: ${rawRef}`);
	}
	return path;
}

async function collectWorkspaceReferenceImages(config: Config, rawRef: string): Promise<WorkspaceReferenceImage[]> {
	const path = resolveWorkspaceReferencePath(config, rawRef);
	const pathStat = await lstat(path).catch(() => undefined);
	if (!pathStat) throw new Error(`Reference image path not found: ${rawRef}`);
	if (pathStat.isSymbolicLink()) throw new Error(`Reference image path cannot be a symlink: ${rawRef}`);
	if (pathStat.isDirectory()) {
		throw new Error(`Reference image path must be a file, not a folder: ${rawRef}`);
	}
	if (!pathStat.isFile()) throw new Error(`Reference image path is not a file or folder: ${rawRef}`);
	const mimeType = imageMimeTypeFromPath(path);
	if (!mimeType) throw new Error(`Reference image path is not a supported image: ${rawRef}`);
	return [
		{
			localPath: path,
			name: basename(path),
			mimeType,
			size: pathStat.size,
		},
	];
}

function splitReferenceImages(
	attachments: readonly StoredAttachment[],
	references: readonly string[] | undefined,
): { attachments: StoredAttachment[]; workspaceRefs: string[] } {
	if (!references?.length) return { attachments: [], workspaceRefs: [] };
	const imageAttachments = attachments.filter((attachment) => {
		return (
			attachment.localPath &&
			attachment.mimeType?.startsWith("image/") &&
			(!attachment.kind || attachment.kind === "image")
		);
	});
	const selected: StoredAttachment[] = [];
	const workspaceRefs: string[] = [];
	const seenAttachments = new Set<string>();
	const seenWorkspaceRefs = new Set<string>();
	for (const rawRef of references) {
		const ref = rawRef.trim();
		if (!ref) continue;
		const attachment = imageAttachments.find((candidate) => candidate.id === ref || candidate.name === ref);
		if (attachment) {
			if (seenAttachments.has(attachment.id)) continue;
			seenAttachments.add(attachment.id);
			selected.push(attachment);
			continue;
		}
		const anyAttachment = attachments.find((candidate) => candidate.id === ref || candidate.name === ref);
		if (anyAttachment) {
			throw new Error(`Reference image is not an image attachment: ${ref}`);
		}
		if (seenWorkspaceRefs.has(ref)) continue;
		seenWorkspaceRefs.add(ref);
		workspaceRefs.push(ref);
	}
	return { attachments: selected, workspaceRefs };
}

async function workspaceReferenceAttachments(
	config: Config,
	images: WorkspaceReferenceImage[],
): Promise<StoredAttachment[]> {
	const attachments: StoredAttachment[] = [];
	for (const image of images) {
		const attachment: StoredAttachment = {
			id: `workspace:${image.localPath}`,
			name: image.name,
			kind: "image",
			mimeType: image.mimeType,
			size: image.size,
			localPath: image.localPath,
		};
		const derivedImage = await ensureInlineImageDerivative(config, attachment);
		if (derivedImage) {
			attachment.derived = {
				...attachment.derived,
				image: derivedImage,
			};
		}
		attachments.push(attachment);
	}
	return attachments;
}

async function buildImageContext(
	model: ImagesModel<ImageGenApi>,
	prompt: string,
	references: StoredAttachment[],
	workspaceRefs: readonly string[],
	config: Config,
): Promise<ImagesContext> {
	const input: ImagesContext["input"] = [{ type: "text", text: prompt }];
	const hasReferences = references.length > 0 || workspaceRefs.some((ref) => ref.trim().length > 0);
	if (!hasReferences) return { input };
	if (!model.input.includes("image")) {
		throw new Error(`Image model does not support reference images: ${model.provider}/${model.id}`);
	}
	const workspaceImages: WorkspaceReferenceImage[] = [];
	const seenWorkspaceImagePaths = new Set<string>();
	for (const rawRef of workspaceRefs) {
		if (!rawRef.trim()) continue;
		for (const image of await collectWorkspaceReferenceImages(config, rawRef)) {
			if (seenWorkspaceImagePaths.has(image.localPath)) continue;
			seenWorkspaceImagePaths.add(image.localPath);
			workspaceImages.push(image);
		}
	}
	const promptImages = await promptImagesFromAttachments([
		...references,
		...(await workspaceReferenceAttachments(config, workspaceImages)),
	]);
	if (promptImages.promptSuffix) input.push({ type: "text", text: promptImages.promptSuffix });
	input.push(...promptImages.images);
	if (!promptImages.images.length) throw new Error("No reference images could be inlined for image_gen.");
	return { input };
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
	prompt: string,
	references: StoredAttachment[],
	workspaceRefs: readonly string[],
	signal: AbortSignal | undefined,
	generate: ImagesFunction<any, any>,
): Promise<{ model: ImagesModel<ImageGenApi>; result: AssistantImages }> {
	const model = resolveImageModel(config, ref);
	const context = await buildImageContext(model, prompt, references, workspaceRefs, config);
	const result = await generate(model, context, {
		apiKey: resolveImageModelApiKey(config, model),
		signal,
		timeoutMs: config.imageGen.timeoutMs,
	});
	return {
		model,
		result: await normalizeCompatibleImageText(result, { signal }),
	};
}

function attemptDetails(model: ImagesModel<ImageGenApi>, result: AssistantImages): ImageGenAttemptDetails {
	return {
		model: `${model.provider}/${model.id}`,
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
		label: "Image Gen",
		description: "make an image from a prompt. pass referenceImages to riff on existing pictures.",
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
			const allAttachmentRefs = deps.referenceAttachments?.() ?? [];
			const { attachments: attachmentReferences, workspaceRefs: workspaceReferences } = splitReferenceImages(
				allAttachmentRefs,
				input.referenceImages,
			);

			const generate = deps.generateImages ?? generateImages;
			const attempts: ImageGenAttemptDetails[] = [];
			let selected: { model: ImagesModel<ImageGenApi>; result: AssistantImages } | undefined;
			let selectedError = "";
			for (const ref of [primaryRef, fallbackRef].filter((ref): ref is ModelRef => !!ref)) {
				let attempt:
					| {
							model: ImagesModel<ImageGenApi>;
							result: AssistantImages;
					  }
					| undefined;
				try {
					attempt = await tryGenerateImages(
						config,
						ref,
						prompt,
						attachmentReferences,
						workspaceReferences,
						signal,
						generate,
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					attempts.push({
						model: `${ref.provider}/${ref.id}`,
						stopReason: "error",
						errorMessage: message,
					});
					if (message.includes("does not support reference images") && ref === primaryRef && fallbackRef) {
						selectedError = message;
						continue;
					}
					throw error;
				}
				if (!attempt) continue;
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
			const primaryAttachment = attachments[0];
			const notices = attachments.map((attachment) => formatImageGenNotice(attachment.name));
			const sideText = textOutput(selected.result);
			const selectedAttempt = attempts.at(-1);
			return {
				content: [
					{
						type: "text",
						text: [sideText, ...notices].filter(Boolean).join("\n"),
					},
				],
				details: {
					model: `${selected.model.provider}/${selected.model.id}`,
					...(sideText ? { textOutput: sideText } : {}),
					...(primaryAttachment ? { id: primaryAttachment.id, localPath: primaryAttachment.localPath } : {}),
					stopReason: selectedAttempt?.stopReason ?? selected.result.stopReason,
					...(selectedAttempt?.errorMessage ? { errorMessage: selectedAttempt.errorMessage } : {}),
				},
			};
		},
	};
}
