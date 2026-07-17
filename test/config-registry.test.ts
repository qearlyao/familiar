import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONFIG_REGISTRY } from "../src/config/registry.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

describe("TTS config registry", () => {
	it("validates and updates voice and model ids", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const voice = CONFIG_REGISTRY["tts.voice_id"];
		const model = CONFIG_REGISTRY["tts.model_id"];

		voice.write(config, voice.validate("  voice-123  ", config));
		model.write(config, model.validate("  eleven_v3  ", config));

		assert.equal(voice.read(config), "voice-123");
		assert.equal(model.read(config), "eleven_v3");
		assert.equal(voice.validate("  ", config), "");
		assert.throws(() => model.validate("  ", config), /tts\.model_id must not be empty/);
		assert.throws(() => voice.validate(123, config), /tts\.voice_id must be a string/);
	});
});
