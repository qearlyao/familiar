import type { AssistantImages, ImagesFunction, ImagesOptions } from "@earendil-works/pi-ai/compat";

import {
	apiKeyOrThrow,
	assertOk,
	headersFor,
	imageFromBase64,
	imageRequestContext,
	MAX_GENERATED_IMAGES,
	readJson,
	runImageRequest,
	withDefaultPath,
} from "./shared.js";

interface OpenRouterImagesResponse {
	data?: {
		b64_json?: string;
		media_type?: string;
	}[];
}

/**
 * OpenRouter's dedicated Image API — `POST {base}/images` with a prompt and
 * optional `input_references`. Every image model OpenRouter adds now lands
 * here only (FLUX.3 among them); the older chat-completions route with image
 * modalities is what `openrouter-images` speaks. Output is always base64.
 */
export const generateImages: ImagesFunction<ImagesOptions> = (model, context, options) =>
	runImageRequest(model, options, async (fetchImpl, signal) => {
		const apiKey = apiKeyOrThrow(model, options);
		const url = `${withDefaultPath(model.baseUrl, "/api/v1")}/images`;
		const request = imageRequestContext(context);
		if (!request.prompt.trim()) throw new Error("Image generation requires a prompt");

		const inputReferences = request.references.map((reference) => ({
			type: "image_url",
			image_url: { url: `data:${reference.mimeType};base64,${reference.data}` },
		}));
		const response = await fetchImpl(url, {
			method: "POST",
			headers: headersFor(model, options, {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			}),
			body: JSON.stringify({
				model: model.id,
				prompt: request.prompt,
				...(inputReferences.length ? { input_references: inputReferences } : {}),
			}),
			...(signal ? { signal } : {}),
		});
		await assertOk(response, url);

		const json = (await readJson(response, url)) as OpenRouterImagesResponse;
		const entries = json.data ?? [];
		const output: AssistantImages["output"] = [];
		for (const entry of entries) {
			if (!entry.b64_json || output.length >= MAX_GENERATED_IMAGES) continue;
			output.push(imageFromBase64(entry.b64_json, entry.media_type));
		}
		if (!output.length) {
			throw new Error(`No image in the response from ${url}: ${entries.length} entries, none with b64_json`);
		}
		return output;
	});
