import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONFIG_REGISTRY } from "../src/config/registry.js";
import type { Config } from "../src/config/types.js";
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

	it("validates the provider switch and cartesia ids", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const provider = CONFIG_REGISTRY["tts.provider"];
		const voice = CONFIG_REGISTRY["tts.cartesia.voice_id"];
		const model = CONFIG_REGISTRY["tts.cartesia.model_id"];

		provider.write(config, provider.validate("cartesia", config));
		voice.write(config, voice.validate("  voice-abc  ", config));
		model.write(config, model.validate("sonic-3.5", config));

		assert.equal(provider.read(config), "cartesia");
		assert.equal(voice.read(config), "voice-abc");
		assert.equal(model.read(config), "sonic-3.5");
		assert.throws(() => provider.validate("other", config), /tts\.provider must be one of/);
		assert.throws(() => model.validate("  ", config), /tts\.cartesia\.model_id must not be empty/);
	});
});

describe("channel config registry", () => {
	it("validates and writes enabled booleans", () => {
		const config = {
			discord: { enabled: true },
			qq: { enabled: true },
		} as unknown as Config;

		for (const [key, target] of [
			["discord.enabled", config.discord],
			["qq.enabled", config.qq],
		] as const) {
			const entry = CONFIG_REGISTRY[key];
			assert.equal(entry.validate(false, config), false);
			entry.write(config, false);
			assert.equal(target.enabled, false);
			assert.throws(() => entry.validate("false", config), /must be a boolean/);
		}
	});
});
