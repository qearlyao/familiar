import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listVoices, parseCartesiaVoices, parseElevenLabsVoices } from "../src/media/voice-list.js";
import { configWithDataDir } from "./helpers.js";

describe("voice list", () => {
	it("keeps id, name, category and labels, and skips voices without an id", () => {
		const parsed = parseElevenLabsVoices({
			voices: [
				{ voice_id: "v1", name: "Rachel", category: "premade", labels: { accent: "american", gender: "female", empty: "" } },
				{ voice_id: "v2", labels: null },
				{ name: "no id" },
			],
			has_more: false,
			next_page_token: null,
		});
		assert.deepEqual(parsed.voices, [
			{ id: "v1", name: "Rachel", category: "premade", labels: ["american", "female"] },
			{ id: "v2", name: "v2", category: undefined, labels: [] },
		]);
		assert.equal(parsed.next, undefined);
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
		const voices = await listVoices(config);
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
		await assert.rejects(listVoices(config), /TEST_ELEVENLABS_KEY_UNSET/);

		const keyed = await configWithDataDir(t, "/workspace/data", { tts: { apiKeyEnv: "TEST_ELEVENLABS_KEY" } });
		process.env.TEST_ELEVENLABS_KEY = "secret";
		t.after(() => delete process.env.TEST_ELEVENLABS_KEY);
		t.mock.method(globalThis, "fetch", async () => new Response('{"detail":"missing_permissions"}', { status: 401 }));
		await assert.rejects(listVoices(keyed), /elevenlabs voices failed: 401 .*missing_permissions/);
	});

	it("reads Cartesia voices and pages after the last id", async (t) => {
		const parsed = parseCartesiaVoices({
			data: [
				{ id: "c1", name: "Katie", gender: "gender_neutral", is_owner: false, tagline: "calm narrator", accents: [{ accent: "American", locale: "en-US" }] },
				{ id: "c2", name: "Mine", is_owner: true },
			],
			has_more: true,
			next_page: null,
		});
		assert.deepEqual(parsed.voices, [
			{ id: "c1", name: "Katie", category: "public", labels: ["gender neutral", "en-US", "calm narrator"] },
			{ id: "c2", name: "Mine", category: "yours", labels: [] },
		]);
		assert.equal(parsed.next, "c2");

		const config = await configWithDataDir(t, "/workspace/data", { tts: { provider: "cartesia", cartesia: { apiKeyEnv: "TEST_CARTESIA_KEY", voiceId: "", modelId: "sonic-3.5" } } });
		process.env.TEST_CARTESIA_KEY = "csecret";
		t.after(() => delete process.env.TEST_CARTESIA_KEY);
		const seen: URL[] = [];
		t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
			seen.push(input);
			const headers = init.headers as Record<string, string>;
			assert.equal(headers.authorization, "Bearer csecret");
			assert.ok(headers["cartesia-version"]);
			return Response.json(
				input.searchParams.get("starting_after") === "a"
					? { data: [{ id: "b", name: "B" }], has_more: false }
					: { data: [{ id: "a", name: "A" }], has_more: true },
			);
		});
		assert.deepEqual(
			(await listVoices(config)).map((voice) => voice.id),
			["a", "b"],
		);
		assert.equal(seen[0]?.origin + seen[0]?.pathname, "https://api.cartesia.ai/voices");
		assert.equal(seen[0]?.searchParams.get("limit"), "100");
	});
});
