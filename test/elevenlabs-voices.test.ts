import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listElevenLabsVoices, parseElevenLabsVoices } from "../src/media/elevenlabs-voices.js";
import { configWithDataDir } from "./helpers.js";

describe("elevenlabs voices", () => {
	it("keeps id, name, category and labels, and skips voices without an id", () => {
		const parsed = parseElevenLabsVoices({
			voices: [
				{ voice_id: "v1", name: "Rachel", category: "premade", labels: { accent: "american", gender: "female", empty: "" }, preview_url: "https://x/p.mp3" },
				{ voice_id: "v2", labels: null },
				{ name: "no id" },
			],
			has_more: false,
			next_page_token: null,
		});
		assert.deepEqual(parsed.voices, [
			{ id: "v1", name: "Rachel", category: "premade", labels: ["american", "female"], previewUrl: "https://x/p.mp3" },
			{ id: "v2", name: "v2", category: undefined, labels: [], previewUrl: undefined },
		]);
		assert.equal(parsed.nextPageToken, undefined);
		assert.throws(() => parseElevenLabsVoices({ detail: "nope" }), /invalid response/);
	});

	it("pages through v2/voices with the configured key", async (t) => {
		const config = await configWithDataDir(t, "/workspace/data", { tts: { apiKeyEnv: "TEST_ELEVENLABS_KEY" } });
		process.env.TEST_ELEVENLABS_KEY = "secret";
		t.after(() => delete process.env.TEST_ELEVENLABS_KEY);
		const seen: URL[] = [];
		t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
			seen.push(input);
			assert.equal((init.headers as Record<string, string>)["xi-api-key"], "secret");
			const second = input.searchParams.get("next_page_token") === "page2";
			return Response.json(
				second
					? { voices: [{ voice_id: "b", name: "B" }], has_more: false, next_page_token: null }
					: { voices: [{ voice_id: "a", name: "A" }], has_more: true, next_page_token: "page2" },
			);
		});
		const voices = await listElevenLabsVoices(config);
		assert.deepEqual(
			voices.map((voice) => voice.id),
			["a", "b"],
		);
		assert.equal(seen.length, 2);
		assert.equal(seen[0]?.origin + seen[0]?.pathname, "https://api.elevenlabs.io/v2/voices");
		assert.equal(seen[0]?.searchParams.get("page_size"), "100");
	});

	it("says which env is missing, and passes an upstream error through", async (t) => {
		const config = await configWithDataDir(t, "/workspace/data", { tts: { apiKeyEnv: "TEST_ELEVENLABS_KEY_UNSET" } });
		await assert.rejects(listElevenLabsVoices(config), /TEST_ELEVENLABS_KEY_UNSET/);

		const keyed = await configWithDataDir(t, "/workspace/data", { tts: { apiKeyEnv: "TEST_ELEVENLABS_KEY" } });
		process.env.TEST_ELEVENLABS_KEY = "secret";
		t.after(() => delete process.env.TEST_ELEVENLABS_KEY);
		t.mock.method(globalThis, "fetch", async () => new Response('{"detail":"missing_permissions"}', { status: 401 }));
		await assert.rejects(listElevenLabsVoices(keyed), /elevenlabs voices failed: 401 .*missing_permissions/);
	});
});
