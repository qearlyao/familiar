import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEmbeddingProvider } from "../src/memory/index/embedding-provider.js";
import { configWithDataDir, createTempDataDir, withEnv } from "./helpers.js";

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
	});
}

function roundedEmbeddingValues(embeddings: Float32Array[]): number[][] {
	return embeddings.map((embedding) => Array.from(embedding, (value) => Number(value.toFixed(3))));
}

describe("embedding provider", () => {
	it("calls Gemini batch embeddings with configured provider settings", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			memory: {
				embedding: {
					format: "gemini",
					provider: "google",
					model: "gemini-embedding-2",
					baseUrl: "https://gateway.example.test/v1beta",
					apiKeyEnv: "EMBEDDING_TEST_KEY",
					dimensions: 3,
					batchSize: 4,
				},
			},
		});
		const requests: Array<{ url: string; init?: RequestInit; body: any }> = [];
		const fetchFn = (async (input, init) => {
			requests.push({
				url: String(input),
				init,
				body: JSON.parse(String(init?.body)),
			});
			return jsonResponse({
				embeddings: [{ values: [0.1, 0.2, 0.3] }, { values: [0.4, 0.5, 0.6] }],
			});
		}) as typeof fetch;

		await withEnv("EMBEDDING_TEST_KEY", "embedding-key", async () => {
			const provider = createEmbeddingProvider(config, { fetchFn });
			const embeddings = await provider.embed([
				"hello",
				{
					parts: [
						{ type: "text", text: "caption" },
						{ type: "inlineData", mimeType: "image/png", data: "aW1hZ2U=" },
					],
				},
			]);

			assert.equal(provider.api, "gemini");
			assert.equal(provider.provider, "google");
			assert.equal(requests.length, 1);
			assert.match(
				requests[0]?.url ?? "",
				/^https:\/\/gateway\.example\.test\/v1beta\/models\/gemini-embedding-2:batchEmbedContents/,
			);
			assert.doesNotMatch(requests[0]?.url ?? "", /key=/);
			assert.equal((requests[0]?.init?.headers as Record<string, string>)["x-goog-api-key"], "embedding-key");
			assert.deepEqual(requests[0]?.body, {
				requests: [
					{
						model: "models/gemini-embedding-2",
						content: { parts: [{ text: "hello" }] },
						outputDimensionality: 3,
					},
					{
						model: "models/gemini-embedding-2",
						content: {
							parts: [
								{ text: "caption" },
								{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } },
							],
						},
						outputDimensionality: 3,
					},
				],
			});
			assert.deepEqual(roundedEmbeddingValues(embeddings), [
				[0.1, 0.2, 0.3],
				[0.4, 0.5, 0.6],
			]);
		});
	});

	it("splits requests by configured batch size", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			memory: {
				embedding: {
					format: "gemini",
					provider: "local-gateway",
					model: "embed",
					baseUrl: "http://localhost:9999/v1beta",
					apiKeyEnv: "",
					dimensions: 2,
					batchSize: 2,
				},
			},
		});
		const requestSizes: number[] = [];
		const fetchFn = (async (_input, init) => {
			const body = JSON.parse(String(init?.body));
			requestSizes.push(body.requests.length);
			return jsonResponse({
				embeddings: body.requests.map(() => ({ values: [1, 2] })),
			});
		}) as typeof fetch;

		const provider = createEmbeddingProvider(config, { fetchFn });
		const embeddings = await provider.embed(["a", "b", "c"]);

		assert.deepEqual(requestSizes, [2, 1]);
		assert.deepEqual(roundedEmbeddingValues(embeddings), [
			[1, 2],
			[1, 2],
			[1, 2],
		]);
	});

	it("returns an empty list for empty input", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const provider = createEmbeddingProvider(config, {
			fetchFn: (() => {
				throw new Error("fetch should not be called");
			}) as typeof fetch,
		});

		assert.deepEqual(await provider.embed([]), []);
	});

	it("accepts singular embedding responses for single input", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			memory: {
				embedding: {
					format: "gemini",
					provider: "google",
					model: "models/gemini-embedding-2",
					baseUrl: "https://gateway.example.test/v1beta",
					apiKeyEnv: "",
					dimensions: 2,
					batchSize: 4,
				},
			},
		});
		const requestedUrls: string[] = [];
		const fetchFn = (async (input) => {
			requestedUrls.push(String(input));
			return jsonResponse({ embedding: { values: [0.1, 0.2] } });
		}) as typeof fetch;
		const provider = createEmbeddingProvider(config, { fetchFn });

		const embedding = await provider.embedOne("hello");

		assert.deepEqual(roundedEmbeddingValues([embedding]), [[0.1, 0.2]]);
		assert.equal(requestedUrls[0], "https://gateway.example.test/v1beta/models/gemini-embedding-2:batchEmbedContents");
	});

	it("rejects embedding response count mismatches", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			memory: {
				embedding: {
					format: "gemini",
					provider: "google",
					model: "gemini-embedding-2",
					baseUrl: "https://gateway.example.test/v1beta",
					apiKeyEnv: "",
					dimensions: 2,
					batchSize: 4,
				},
			},
		});
		const fetchFn = (async () => jsonResponse({ embeddings: [{ values: [1, 2] }] })) as typeof fetch;
		const provider = createEmbeddingProvider(config, { fetchFn });

		await assert.rejects(() => provider.embed(["a", "b"]), /count mismatch/);
	});

	it("rejects embeddings with unexpected dimensions", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			memory: {
				embedding: {
					format: "gemini",
					provider: "google",
					model: "gemini-embedding-2",
					baseUrl: "https://gateway.example.test/v1beta",
					apiKeyEnv: "",
					dimensions: 3,
					batchSize: 4,
				},
			},
		});
		const fetchFn = (async () => jsonResponse({ embeddings: [{ values: [0.1, 0.2] }] })) as typeof fetch;
		const provider = createEmbeddingProvider(config, { fetchFn });

		await assert.rejects(() => provider.embedOne("hello"), /dimension mismatch/);
	});

	it("does not retry permanent or quota errors", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		for (const [status, message] of [
			[400, "bad request"],
			[429, "quota exceeded"],
		] as const) {
			let calls = 0;
			const fetchFn = (async () => {
				calls += 1;
				return jsonResponse({ error: { message } }, status);
			}) as typeof fetch;
			const provider = createEmbeddingProvider(config, { fetchFn });

			await assert.rejects(() => provider.embedOne("hello"), new RegExp(message));
			assert.equal(calls, 1);
		}
	});

	it("retries transient 5xx errors and honors Retry-After", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			memory: { embedding: { dimensions: 2 } },
		});
		let calls = 0;
		const delays: number[] = [];
		const fetchFn = (async () => {
			calls += 1;
			return calls === 1
				? jsonResponse({ error: { message: "unavailable" } }, 503, { "retry-after": "2" })
				: jsonResponse({ embedding: { values: [1, 2] } });
		}) as typeof fetch;
		const provider = createEmbeddingProvider(config, {
			fetchFn,
			sleepFn: async (delayMs) => {
				delays.push(delayMs);
			},
		});

		assert.deepEqual(roundedEmbeddingValues([await provider.embedOne("hello")]), [[1, 2]]);
		assert.equal(calls, 2);
		assert.deepEqual(delays, [2_000]);
	});

	it("retries network timeouts", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			memory: { embedding: { dimensions: 2 } },
		});
		let calls = 0;
		const fetchFn = (async () => {
			calls += 1;
			if (calls === 1) {
				throw new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
			}
			return jsonResponse({ embedding: { values: [1, 2] } });
		}) as typeof fetch;
		const provider = createEmbeddingProvider(config, { fetchFn, sleepFn: async () => {} });

		await provider.embedOne("hello");
		assert.equal(calls, 2);
	});

	it("does not retry an aborted request", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const controller = new AbortController();
		let calls = 0;
		const fetchFn = (async () => {
			calls += 1;
			controller.abort();
			return jsonResponse({ error: { message: "quota" } }, 429);
		}) as typeof fetch;
		const provider = createEmbeddingProvider(config, { fetchFn });

		await assert.rejects(() => provider.embedOne("hello", controller.signal), { name: "AbortError" });
		assert.equal(calls, 1);
	});

	it("retries transient errors only up to the limit", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		let calls = 0;
		const fetchFn = (async () => {
			calls += 1;
			return new Response("gateway timeout page", { status: 502 });
		}) as typeof fetch;
		const provider = createEmbeddingProvider(config, { fetchFn, sleepFn: async () => {} });

		await assert.rejects(() => provider.embedOne("hello"), /gateway timeout page/);
		assert.equal(calls, 3);
	});
});
