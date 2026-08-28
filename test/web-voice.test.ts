import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildElevenLabsRealtimeSttUrl,
	buildElevenLabsRealtimeTtsInit,
	buildElevenLabsRealtimeTtsUrl,
	normalizeElevenLabsLanguageCode,
	normalizeSpeechEvent,
} from "../src/web/voice.js";
import { configWithDataDir } from "./helpers.js";

describe("web voice protocol", () => {
	it("builds authenticated ElevenLabs realtime URLs from TTS config", async (t) => {
		const config = await configWithDataDir(t, "/workspace/data", {
			tts: {
				voiceId: "voice-1",
				modelId: "eleven_v3",
				voiceCallModelId: "eleven_v3_conversational",
				outputFormat: "mp3_44100_128",
			},
		});

		const stt = new URL(buildElevenLabsRealtimeSttUrl("secret", "zho"));
		assert.equal(stt.searchParams.get("model_id"), "scribe_v2_realtime");
		assert.equal(stt.searchParams.get("audio_format"), "pcm_16000");
		assert.equal(stt.searchParams.get("commit_strategy"), "vad");
		assert.equal(stt.searchParams.get("vad_silence_threshold_secs"), "1.2");
		assert.equal(stt.searchParams.get("language_code"), "zho");
		assert.equal(stt.searchParams.get("token"), "secret");
		const manualStt = new URL(buildElevenLabsRealtimeSttUrl("secret", undefined, "push_to_talk"));
		assert.equal(manualStt.searchParams.get("commit_strategy"), "manual");
		assert.equal(manualStt.searchParams.get("vad_silence_threshold_secs"), null);
		assert.equal(normalizeElevenLabsLanguageCode("en-US"), undefined);
		assert.equal(normalizeElevenLabsLanguageCode("ENG"), "eng");

		const tts = new URL(buildElevenLabsRealtimeTtsUrl(config));
		assert.equal(tts.pathname, "/v1/text-to-dialogue/stream-input");
		assert.equal(tts.searchParams.get("model_id"), "eleven_v3_conversational");
		// realtime playback always asks for raw PCM, regardless of the attachment format in config
		assert.equal(tts.searchParams.get("output_format"), "pcm_24000");
		assert.deepEqual(buildElevenLabsRealtimeTtsInit(config, "secret"), {
			voices: ["voice-1"],
			xi_api_key: "secret",
			voice_settings: { stability: 0.5 },
		});
	});

	it("normalizes partial and committed transcripts", () => {
		assert.deepEqual(normalizeSpeechEvent({ message_type: "partial_transcript", text: "hel" }), {
			type: "transcript",
			final: false,
			text: "hel",
		});
		assert.deepEqual(normalizeSpeechEvent({ message_type: "committed_transcript", text: "hello" }), {
			type: "transcript",
			final: true,
			text: "hello",
		});
	});
});
