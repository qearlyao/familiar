import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { audioExtension, audioMimeType } from "../src/tts.js";

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
