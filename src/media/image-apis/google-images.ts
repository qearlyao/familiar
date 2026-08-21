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

interface GeminiInlineData {
	mimeType?: string;
	mime_type?: string;
	data?: string;
}

interface GeminiResponse {
	candidates?: {
		finishReason?: string;
		content?: {
			parts?: {
				text?: string;
				inlineData?: GeminiInlineData;
				inline_data?: GeminiInlineData;
			}[];
		};
	}[];
	promptFeedback?: { blockReason?: string };
}

/**
 * The Google Generative Language image path — `POST {base}/models/{id}:generateContent`
 * authenticated with `x-goog-api-key`. This is the native endpoint for the
 * Gemini image models (Nano Banana and successors); reference images ride
 * inline in the same `contents` array as the prompt.
 */
export const generateImages: ImagesFunction<string, ImagesOptions> = (model, context, options) =>
	runImageRequest(model, options, async (fetchImpl, signal) => {
		const apiKey = apiKeyOrThrow(model, options);
		const base = withDefaultPath(model.baseUrl, "/v1beta");
		const url = `${base}/models/${encodeURIComponent(model.id)}:generateContent`;
		const request = imageRequestContext(context);
		if (!request.prompt.trim()) throw new Error("Image generation requires a prompt");

		// The REST docs use snake_case for inline data; Google accepts either.
		const parts: ({ text: string } | { inline_data: { mime_type: string; data: string } })[] = [];
		for (const reference of request.references) {
			parts.push({ inline_data: { mime_type: reference.mimeType, data: reference.data } });
		}
		parts.push({ text: request.prompt });

		const response = await fetchImpl(url, {
			method: "POST",
			headers: headersFor(model, options, { "content-type": "application/json", "x-goog-api-key": apiKey }),
			body: JSON.stringify({
				contents: [{ role: "user", parts }],
				generationConfig: { responseModalities: ["IMAGE"] },
			}),
			...(signal ? { signal } : {}),
		});
		await assertOk(response, url);

		const json = (await readJson(response, url)) as GeminiResponse;
		const output: AssistantImages["output"] = [];
		let images = 0;
		for (const candidate of json.candidates ?? []) {
			for (const part of candidate.content?.parts ?? []) {
				if (part.text) output.push({ type: "text", text: part.text });
				// camelCase is the REST shape, snake_case the proto one; gateways vary.
				const inline = part.inlineData ?? part.inline_data;
				if (!inline?.data || images >= MAX_GENERATED_IMAGES) continue;
				output.push(imageFromBase64(inline.data, inline.mimeType ?? inline.mime_type));
				images += 1;
			}
		}
		if (!images) {
			const blockReason = json.promptFeedback?.blockReason;
			const finishReason = json.candidates?.[0]?.finishReason;
			const reason = blockReason ?? finishReason ?? "no image parts in the response";
			throw new Error(`No image in the response from ${url}: ${reason}`);
		}
		return output;
	});
