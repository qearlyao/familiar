import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Model } from "@earendil-works/pi-ai";

import { createVertexContextCacheNormalizer, type VertexContextCacheClient } from "../src/vertex-context-cache.js";

const vertexModel: Model<any> = {
	id: "gemini-3.1-pro-preview",
	name: "gemini-3.1-pro-preview",
	api: "google-vertex",
	provider: "google-vertex",
	baseUrl: "https://us-central1-aiplatform.googleapis.com",
	reasoning: true,
	input: ["text", "image"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 200000,
	maxTokens: 8192,
};

type TestPayload = {
	model: string;
	contents: unknown[];
	config: Record<string, unknown>;
};

function payload(contents = [{ role: "user", parts: [{ text: "hi" }] }]): TestPayload {
	return {
		model: "gemini-3.1-pro-preview",
		contents,
		config: {
			maxOutputTokens: 8192,
			systemInstruction: "system prompt",
			tools: [{ functionDeclarations: [{ name: "read", parametersJsonSchema: { type: "object" } }] }],
			thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
			abortSignal: new AbortController().signal,
		},
	};
}

describe("Vertex context cache normalizer", () => {
	it("creates a Vertex cachedContent resource and strips cache-backed config", async () => {
		const createCalls: Array<{ model: string; config: Record<string, unknown> }> = [];
		const client: VertexContextCacheClient = {
			async create(params) {
				createCalls.push(params);
				return { name: "cachedContents/stable-prefix", expireTime: "2026-05-09T05:00:00Z" };
			},
		};
		const normalizer = createVertexContextCacheNormalizer({
			retention: "short",
			sessionId: "session-1",
			getApiKey: () => "key",
			createClient: () => client,
			now: () => Date.parse("2026-05-09T04:00:00Z"),
		});

		const request = payload();
		const normalized = (await normalizer.normalize(request, vertexModel)) as TestPayload;

		assert.equal(createCalls.length, 1);
		assert.equal(createCalls[0]?.model, "gemini-3.1-pro-preview");
		assert.equal(createCalls[0]?.config.systemInstruction, "system prompt");
		assert.deepEqual(createCalls[0]?.config.tools, request.config.tools);
		assert.equal(createCalls[0]?.config.ttl, "300s");
		assert.equal(normalized.config.cachedContent, "cachedContents/stable-prefix");
		assert.equal(normalized.config.systemInstruction, undefined);
		assert.equal(normalized.config.tools, undefined);
		assert.deepEqual(normalized.contents, request.contents);
	});

	it("reuses the cached prefix when later contents extend the same conversation", async () => {
		let createCount = 0;
		const client: VertexContextCacheClient = {
			async create() {
				createCount += 1;
				return { name: "cachedContents/history", expireTime: "2026-05-09T05:00:00Z" };
			},
		};
		const normalizer = createVertexContextCacheNormalizer({
			retention: "long",
			sessionId: "session-1",
			getApiKey: () => "key",
			createClient: () => client,
			now: () => Date.parse("2026-05-09T04:00:00Z"),
		});
		const firstContents = [
			{ role: "user", parts: [{ text: "hello" }] },
			{ role: "model", parts: [{ text: "hi" }] },
			{ role: "user", parts: [{ text: "what now?" }] },
		];
		await normalizer.normalize(payload(firstContents), vertexModel);

		const secondContents = [
			...firstContents,
			{ role: "model", parts: [{ text: "answer" }] },
			{ role: "user", parts: [{ text: "next" }] },
		];
		const normalized = (await normalizer.normalize(payload(secondContents), vertexModel)) as TestPayload;

		assert.equal(createCount, 1);
		assert.deepEqual(normalized.contents, secondContents.slice(2));
		assert.equal(normalized.config.cachedContent, "cachedContents/history");
		assert.equal(normalized.config.systemInstruction, undefined);
		assert.equal(normalized.config.tools, undefined);
	});

	it("leaves requests unchanged when cache creation fails", async () => {
		const normalizer = createVertexContextCacheNormalizer({
			retention: "short",
			sessionId: "session-1",
			getApiKey: () => "key",
			createClient: () => ({
				async create() {
					throw new Error("cache rejected");
				},
			}),
			now: () => Date.parse("2026-05-09T04:00:00Z"),
		});
		const request = payload();

		const normalized = await normalizer.normalize(request, vertexModel);

		assert.equal(normalized, request);
	});
});
