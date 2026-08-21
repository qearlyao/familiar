import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ImagesContext, ImagesModel } from "@earendil-works/pi-ai/compat";

import { generateImages as generateGoogleImages } from "../src/media/image-apis/google-images.js";
import { generateImages as generateOpenAIImages } from "../src/media/image-apis/openai-images.js";
import { withDefaultPath } from "../src/media/image-apis/shared.js";
import { pngBytes } from "./media-fixtures.js";

interface CapturedRequest {
	url: string;
	init: RequestInit;
}

function imageModel(api: string, baseUrl: string, overrides: Partial<ImagesModel<string>> = {}): ImagesModel<string> {
	return {
		id: "test-image-model",
		name: "test-image-model",
		api,
		provider: "test-provider",
		baseUrl,
		input: ["text", "image"],
		output: ["image", "text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	} as ImagesModel<string>;
}

/** Capture the outbound request and answer it with a canned response. */
function stubFetch(respond: () => Response): { fetch: typeof fetch; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		requests.push({ url: String(input), init: init ?? {} });
		return respond();
	}) as typeof fetch;
	return { fetch: fetchImpl, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function promptContext(prompt: string): ImagesContext {
	return { input: [{ type: "text", text: prompt }] };
}

function referenceContext(prompt: string): ImagesContext {
	return {
		input: [
			{ type: "text", text: prompt },
			{ type: "image", mimeType: "image/png", data: pngBytes().toString("base64") },
		],
	};
}

describe("image api base URLs", () => {
	it("appends the default path only when the base URL has none of its own", () => {
		assert.equal(withDefaultPath("https://api.openai.com", "/v1"), "https://api.openai.com/v1");
		assert.equal(withDefaultPath("https://api.openai.com/", "/v1"), "https://api.openai.com/v1");
		assert.equal(withDefaultPath("https://api.x.ai/v1", "/v1"), "https://api.x.ai/v1");
		assert.equal(withDefaultPath("http://gateway.internal/openai/v1", "/v1"), "http://gateway.internal/openai/v1");
		assert.equal(withDefaultPath("https://gw.test/v1/", "/v1"), "https://gw.test/v1");
	});

	it("keeps a query the gateway signs into the base URL", () => {
		assert.equal(withDefaultPath("https://gw.test/v1?key=abc", "/v1"), "https://gw.test/v1?key=abc");
	});

	it("rejects an unparseable base URL instead of passing it to fetch", () => {
		assert.throws(() => withDefaultPath("api.linkapi.ai/v1", "/v1"));
	});
});

describe("openai-images api", () => {
	it("posts to images/generations and decodes base64 output", async () => {
		const stub = stubFetch(() => jsonResponse({ data: [{ b64_json: pngBytes().toString("base64") }] }));
		const result = await generateOpenAIImages(
			imageModel("openai-images", "https://api.openai.com"),
			promptContext("a quiet harbor"),
			{ apiKey: "secret", fetch: stub.fetch },
		);

		assert.equal(result.stopReason, "stop");
		assert.equal(stub.requests.length, 1);
		assert.equal(stub.requests[0]?.url, "https://api.openai.com/v1/images/generations");
		const headers = stub.requests[0]?.init.headers as Record<string, string>;
		assert.equal(headers.authorization, "Bearer secret");
		assert.deepEqual(JSON.parse(String(stub.requests[0]?.init.body)), {
			model: "test-image-model",
			prompt: "a quiet harbor",
		});
		assert.deepEqual(result.output, [{ type: "image", mimeType: "image/png", data: pngBytes().toString("base64") }]);
	});

	it("honors a custom base URL that already carries a path", async () => {
		const stub = stubFetch(() => jsonResponse({ data: [{ b64_json: pngBytes().toString("base64") }] }));
		await generateOpenAIImages(imageModel("openai-images", "https://api.x.ai/v1"), promptContext("grok it"), {
			apiKey: "secret",
			fetch: stub.fetch,
		});

		assert.equal(stub.requests[0]?.url, "https://api.x.ai/v1/images/generations");
	});

	it("switches to the multipart edits endpoint when reference images are present", async () => {
		const stub = stubFetch(() => jsonResponse({ data: [{ b64_json: pngBytes().toString("base64") }] }));
		const result = await generateOpenAIImages(
			imageModel("openai-images", "https://api.openai.com"),
			referenceContext("make it dusk"),
			{ apiKey: "secret", fetch: stub.fetch },
		);

		assert.equal(result.stopReason, "stop");
		assert.equal(stub.requests[0]?.url, "https://api.openai.com/v1/images/edits");
		const form = stub.requests[0]?.init.body as FormData;
		assert.ok(form instanceof FormData);
		assert.equal(form.get("prompt"), "make it dusk");
		assert.ok(form.get("image") instanceof Blob);
	});

	it("leaves the multipart content-type to fetch so the boundary survives", async () => {
		const stub = stubFetch(() => jsonResponse({ data: [{ b64_json: pngBytes().toString("base64") }] }));
		await generateOpenAIImages(
			imageModel("openai-images", "https://api.openai.com", { headers: { "Content-Type": "application/json" } }),
			referenceContext("no boundary loss"),
			{ apiKey: "secret", fetch: stub.fetch },
		);

		const headers = stub.requests[0]?.init.headers as Record<string, string>;
		assert.equal(headers["content-type"], undefined);
		assert.equal(headers["Content-Type"], undefined);
		assert.equal(headers.authorization, "Bearer secret");
	});

	it("lets model and caller headers override the defaults on the JSON path", async () => {
		const stub = stubFetch(() => jsonResponse({ data: [{ b64_json: pngBytes().toString("base64") }] }));
		await generateOpenAIImages(
			imageModel("openai-images", "https://api.openai.com", { headers: { "x-model": "from-model" } }),
			promptContext("headers"),
			{ apiKey: "secret", fetch: stub.fetch, headers: { "x-caller": "from-caller", "x-model": "caller-wins" } },
		);

		const headers = stub.requests[0]?.init.headers as Record<string, string>;
		assert.equal(headers["content-type"], "application/json");
		assert.equal(headers["x-caller"], "from-caller");
		assert.equal(headers["x-model"], "caller-wins");
	});

	it("stops fetching image URLs once the per-response ceiling is reached", async () => {
		let fetches = 0;
		const stub = stubFetch(() => {
			fetches += 1;
			if (fetches === 1) {
				return jsonResponse({ data: Array.from({ length: 25 }, () => ({ url: "https://cdn.test/image.png" })) });
			}
			return new Response(new Uint8Array(pngBytes()), { status: 200, headers: { "content-type": "image/png" } });
		});
		const result = await generateOpenAIImages(
			imageModel("openai-images", "https://api.openai.com"),
			promptContext("many"),
			{ apiKey: "secret", fetch: stub.fetch },
		);

		assert.equal(result.stopReason, "stop");
		assert.equal(result.output.filter((item) => item.type === "image").length, 10);
		// One response fetch plus at most ten image fetches — never 25.
		assert.equal(stub.requests.length, 11);
	});

	it("fetches provider-hosted image URLs and inlines them", async () => {
		let call = 0;
		const stub = stubFetch(() => {
			call += 1;
			if (call === 1) return jsonResponse({ data: [{ url: "https://cdn.test/image.png" }] });
			return new Response(new Uint8Array(pngBytes()), { status: 200, headers: { "content-type": "image/png" } });
		});
		const result = await generateOpenAIImages(
			imageModel("openai-images", "https://api.openai.com"),
			promptContext("a lighthouse"),
			{ apiKey: "secret", fetch: stub.fetch },
		);

		assert.equal(stub.requests.length, 2);
		assert.equal(stub.requests[1]?.url, "https://cdn.test/image.png");
		assert.deepEqual(result.output, [{ type: "image", mimeType: "image/png", data: pngBytes().toString("base64") }]);
	});

	it("surfaces the provider status and body on an HTTP error", async () => {
		const stub = stubFetch(() => jsonResponse({ error: { message: "model not found" } }, 404));
		const result = await generateOpenAIImages(
			imageModel("openai-images", "https://api.openai.com"),
			promptContext("nope"),
			{ apiKey: "secret", fetch: stub.fetch },
		);

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /404/);
		assert.match(result.errorMessage ?? "", /model not found/);
	});

	it("reports a missing API key without calling the provider", async () => {
		const stub = stubFetch(() => jsonResponse({}));
		const result = await generateOpenAIImages(
			imageModel("openai-images", "https://api.openai.com"),
			promptContext("no key"),
			{ fetch: stub.fetch },
		);

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /No API key/);
		assert.equal(stub.requests.length, 0);
	});

	it("errors when the response carries no image", async () => {
		const stub = stubFetch(() => jsonResponse({ data: [] }));
		const result = await generateOpenAIImages(
			imageModel("openai-images", "https://api.openai.com"),
			promptContext("empty"),
			{ apiKey: "secret", fetch: stub.fetch },
		);

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /No image in the response/);
	});

	it("errors when the endpoint answers with non-JSON", async () => {
		const stub = stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
		const result = await generateOpenAIImages(
			imageModel("openai-images", "https://api.openai.com"),
			promptContext("html"),
			{ apiKey: "secret", fetch: stub.fetch },
		);

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /Expected JSON/);
	});
});

describe("google-images api", () => {
	it("posts to generateContent with the api key header", async () => {
		const stub = stubFetch(() =>
			jsonResponse({
				candidates: [
					{ content: { parts: [{ inlineData: { mimeType: "image/png", data: pngBytes().toString("base64") } }] } },
				],
			}),
		);
		const result = await generateGoogleImages(
			imageModel("google-images", "https://generativelanguage.googleapis.com"),
			promptContext("a paper lantern"),
			{ apiKey: "secret", fetch: stub.fetch },
		);

		assert.equal(result.stopReason, "stop");
		assert.equal(
			stub.requests[0]?.url,
			"https://generativelanguage.googleapis.com/v1beta/models/test-image-model:generateContent",
		);
		const headers = stub.requests[0]?.init.headers as Record<string, string>;
		assert.equal(headers["x-goog-api-key"], "secret");
		const body = JSON.parse(String(stub.requests[0]?.init.body));
		assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "a paper lantern" }] }]);
		assert.deepEqual(body.generationConfig.responseModalities, ["IMAGE"]);
		assert.deepEqual(result.output, [{ type: "image", mimeType: "image/png", data: pngBytes().toString("base64") }]);
	});

	it("inlines reference images ahead of the prompt", async () => {
		const stub = stubFetch(() =>
			jsonResponse({
				candidates: [
					{ content: { parts: [{ inlineData: { mimeType: "image/png", data: pngBytes().toString("base64") } }] } },
				],
			}),
		);
		await generateGoogleImages(
			imageModel("google-images", "https://generativelanguage.googleapis.com/v1beta"),
			referenceContext("at golden hour"),
			{ apiKey: "secret", fetch: stub.fetch },
		);

		const body = JSON.parse(String(stub.requests[0]?.init.body));
		assert.deepEqual(body.contents[0].parts, [
			{ inline_data: { mime_type: "image/png", data: pngBytes().toString("base64") } },
			{ text: "at golden hour" },
		]);
	});

	it("accepts the snake_case inline data shape", async () => {
		const stub = stubFetch(() =>
			jsonResponse({
				candidates: [
					{ content: { parts: [{ inline_data: { mime_type: "image/png", data: pngBytes().toString("base64") } }] } },
				],
			}),
		);
		const result = await generateGoogleImages(
			imageModel("google-images", "https://generativelanguage.googleapis.com"),
			promptContext("proto shape"),
			{ apiKey: "secret", fetch: stub.fetch },
		);

		assert.deepEqual(result.output, [{ type: "image", mimeType: "image/png", data: pngBytes().toString("base64") }]);
	});

	it("reports the block reason when the model refuses", async () => {
		const stub = stubFetch(() => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }));
		const result = await generateGoogleImages(
			imageModel("google-images", "https://generativelanguage.googleapis.com"),
			promptContext("refused"),
			{ apiKey: "secret", fetch: stub.fetch },
		);

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /SAFETY/);
	});

	it("marks a caller abort as aborted rather than an error", async () => {
		const controller = new AbortController();
		controller.abort();
		const stub = stubFetch(() => jsonResponse({}));
		const result = await generateGoogleImages(
			imageModel("google-images", "https://generativelanguage.googleapis.com"),
			promptContext("cancelled"),
			{ apiKey: "secret", fetch: stub.fetch, signal: controller.signal },
		);

		assert.equal(result.stopReason, "aborted");
	});
});
