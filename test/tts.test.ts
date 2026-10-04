import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createGeneratedMediaSink } from "../src/media/generated-media.js";
import {
	audioExtension,
	audioMimeType,
	buildCartesiaRequestBody,
	buildElevenLabsVoiceSettings,
	createTtsTool,
} from "../src/media/tts.js";
import { SILENT_RESPONSE_MARKER } from "../src/runtime/silent-marker.js";
import { configWithDataDir, createTempDataDir, withEnv } from "./helpers.js";

describe("tts audio formats", () => {
	const cases = [
		["mp3_44100_128", "mp3", "audio/mpeg"],
		["pcm_16000", "pcm", "audio/L16"],
		["ulaw_8000", "ulaw", "audio/basic"],
		["alaw_8000", "alaw", "audio/basic"],
		["opus_48000_64", "opus", "audio/ogg"],
	] as const;

	for (const [format, extension, mimeType] of cases) {
		it(`maps ${format}`, () => {
			assert.equal(audioExtension(format), extension);
			assert.equal(audioMimeType(format), mimeType);
		});
	}
});

describe("ElevenLabs voice settings", () => {
	it("includes full voice settings for v2-style models", async (t) => {
		const config = await configWithDataDir(t, "/workspace/data", {
			tts: {
				modelId: "eleven_multilingual_v2",
				voiceSettings: {
					stability: 0.6,
					similarityBoost: 0.8,
					style: 0.2,
					speed: 1.05,
					useSpeakerBoost: false,
				},
			},
		});

		assert.deepEqual(buildElevenLabsVoiceSettings(config), {
			stability: 0.6,
			similarity_boost: 0.8,
			style: 0.2,
			speed: 1.05,
			use_speaker_boost: false,
		});
	});

	it("omits v2-only settings for Eleven v3", async (t) => {
		const config = await configWithDataDir(t, "/workspace/data", {
			tts: {
				modelId: "eleven_v3",
				voiceSettings: {
					stability: 0.45,
					similarityBoost: 0.8,
					style: 0.2,
					speed: 1.05,
					useSpeakerBoost: false,
				},
			},
		});

		assert.deepEqual(buildElevenLabsVoiceSettings(config), {
			stability: 0.45,
		});
	});

	it("sends only stability and similarity for Eleven v4", async (t) => {
		const config = await configWithDataDir(t, "/workspace/data", {
			tts: {
				modelId: "eleven_v4",
				voiceSettings: {
					stability: 0.45,
					similarityBoost: 0.8,
					style: 0.2,
					speed: 1.05,
					useSpeakerBoost: false,
				},
			},
		});

		assert.deepEqual(buildElevenLabsVoiceSettings(config), {
			stability: 0.45,
			similarity_boost: 0.8,
		});
		assert.deepEqual(buildElevenLabsVoiceSettings(config, "eleven_v4_turbo"), {
			stability: 0.45,
			similarity_boost: 0.8,
		});
	});

	it("uses the selected model when building voice settings", async (t) => {
		const config = await configWithDataDir(t, "/workspace/data", {
			tts: {
				modelId: "eleven_multilingual_v2",
				voiceSettings: {
					stability: 0.45,
					similarityBoost: 0.8,
					style: 0.2,
					speed: 1.05,
					useSpeakerBoost: false,
				},
			},
		});

		assert.deepEqual(buildElevenLabsVoiceSettings(config, "eleven_v3_conversational"), {
			stability: 0.45,
		});
	});
});

describe("Cartesia request body", () => {
	it("builds an id-voice mp3 request", async (t) => {
		const config = await configWithDataDir(t, "/workspace/data", {
			tts: {
				cartesia: { apiKeyEnv: "CARTESIA_API_KEY", voiceId: "voice-abc", modelId: "sonic-3.5" },
			},
		});

		assert.deepEqual(buildCartesiaRequestBody(config, "hello there", "voice-abc"), {
			model_id: "sonic-3.5",
			transcript: "hello there",
			voice: { mode: "id", id: "voice-abc" },
			output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
		});
	});
});

describe("tts tool", () => {
	it("tells the agent the voice note travels without any text", async (t) => {
		await withEnv("TEST_TTS_KEY", "secret", async () => {
			const dataDir = await createTempDataDir(t);
			const config = await configWithDataDir(t, dataDir, {
				tts: { provider: "elevenlabs", apiKeyEnv: "TEST_TTS_KEY", voiceId: "voice-1" },
			});
			t.mock.method(globalThis, "fetch", async () => new Response(Buffer.from("fake-mp3")));
			const sink = createGeneratedMediaSink();

			const result = await createTtsTool(config, sink).execute("call-1", { text: "hi there" });

			assert.equal(sink.drain().length, 1);
			const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			assert.match(text, /^Voice message attached to your reply: tts_.+\.mp3\. /);
			assert.ok(text.includes(SILENT_RESPONSE_MARKER));
		});
	});
});
