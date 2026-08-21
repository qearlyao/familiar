import type { AssistantImages, ImagesFunction, ImagesModel, ImagesOptions } from "@earendil-works/pi-ai/compat";

import {
	apiKeyOrThrow,
	assertOk,
	headersFor,
	type ImageRequestContext,
	imageFromBase64,
	imageFromUrl,
	imageRequestContext,
	MAX_GENERATED_IMAGES,
	readJson,
	runImageRequest,
	withDefaultPath,
} from "./shared.js";

interface OpenAIImagesResponse {
	data?: {
		b64_json?: string;
		url?: string;
		revised_prompt?: string;
	}[];
}

/**
 * Multipart body for the edits endpoint. A single reference goes in `image`;
 * several go in repeated `image[]` fields, which is how gpt-image-2 accepts
 * multi-image edits.
 */
function referenceForm(model: ImagesModel<string>, request: ImageRequestContext): FormData {
	const form = new FormData();
	form.append("model", model.id);
	form.append("prompt", request.prompt);
	const field = request.references.length > 1 ? "image[]" : "image";
	for (const [index, reference] of request.references.entries()) {
		const bytes = Buffer.from(reference.data, "base64");
		form.append(field, new Blob([bytes], { type: reference.mimeType }), `reference-${index}`);
	}
	return form;
}

async function parseResponse(
	response: Response,
	url: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal | undefined,
): Promise<AssistantImages["output"]> {
	const json = (await readJson(response, url)) as OpenAIImagesResponse;
	const entries = json.data ?? [];
	const output: AssistantImages["output"] = [];
	let images = 0;
	for (const entry of entries) {
		if (entry.revised_prompt) output.push({ type: "text", text: entry.revised_prompt });
		// Stop before the cap: a `url` entry costs a fetch, so the ceiling has
		// to bound the work, not just the result.
		if (images >= MAX_GENERATED_IMAGES) continue;
		if (entry.b64_json) output.push(imageFromBase64(entry.b64_json));
		else if (entry.url) output.push(await imageFromUrl(entry.url, fetchImpl, signal));
		else continue;
		images += 1;
	}
	if (!images) {
		throw new Error(`No image in the response from ${url}: ${entries.length} entries, none with b64_json or url`);
	}
	return output;
}

/**
 * The OpenAI images API — `/v1/images/generations` for text-to-image and
 * `/v1/images/edits` (multipart) when reference images are present, which is
 * the split OpenAI documents: generations takes no input image, and edits
 * covers editing, style reference, and composition with `mask` optional.
 * Spoken natively by OpenAI and by the many gateways that mirror the same
 * routes. `models.base_urls` picks the host; a base URL that already carries a
 * path is used verbatim, so non-canonical mounts work too.
 *
 * xAI matches on generations but not on edits, where it wants a JSON body with
 * `image: { url, type }` rather than multipart — so reference images are not
 * supported against api.x.ai through this api style.
 */
export const generateImages: ImagesFunction<string, ImagesOptions> = (model, context, options) =>
	runImageRequest(model, options, async (fetchImpl, signal) => {
		const apiKey = apiKeyOrThrow(model, options);
		const base = withDefaultPath(model.baseUrl, "/v1");
		const request = imageRequestContext(context);
		if (!request.prompt.trim()) throw new Error("Image generation requires a prompt");

		const editing = request.references.length > 0;
		const url = `${base}/images/${editing ? "edits" : "generations"}`;
		const body = editing
			? referenceForm(model, request)
			: JSON.stringify({ model: model.id, prompt: request.prompt });
		const headers = headersFor(model, options, {
			authorization: `Bearer ${apiKey}`,
			...(editing ? {} : { "content-type": "application/json" }),
		});
		// fetch derives the multipart content-type, boundary included, so any
		// inherited one has to go or the request body becomes unparseable.
		if (editing) delete headers["content-type"];

		const response = await fetchImpl(url, {
			method: "POST",
			headers,
			body,
			...(signal ? { signal } : {}),
		});
		await assertOk(response, url);
		return parseResponse(response, url, fetchImpl, signal);
	});
