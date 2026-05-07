import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { createWorkspace, minimalConfigToml } from "./helpers.js";

describe("loadConfig tts", () => {
	const envKeys = ["DISCORD_TOKEN", "ELEVENLABS_VOICE_ID"] as const;
	const originalEnv = new Map<string, string | undefined>();

	before(() => {
		for (const key of envKeys) originalEnv.set(key, process.env[key]);
	});

	after(() => {
		for (const key of envKeys) {
			const value = originalEnv.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("uses ElevenLabs defaults when tts config is omitted", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		delete process.env.ELEVENLABS_VOICE_ID;
		const workspacePath = await createWorkspace(minimalConfigToml());

		const config = await loadConfig(workspacePath);

		assert.equal(config.tts.provider, "elevenlabs");
		assert.equal(config.tts.apiKeyEnv, "ELEVENLABS_API_KEY");
		assert.equal(config.tts.voiceId, "");
		assert.equal(config.tts.modelId, "eleven_multilingual_v2");
		assert.equal(config.tts.outputFormat, "mp3_44100_128");
		assert.equal(config.tts.maxInputChars, 5000);
		assert.equal(config.media.generatedRetentionDays, 30);
		assert.deepEqual(config.tts.voiceSettings, {
			stability: 0.5,
			similarityBoost: 0.75,
			style: 0,
			speed: 1,
			useSpeakerBoost: true,
		});
	});

	it("interpolates voice id from the environment", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		process.env.ELEVENLABS_VOICE_ID = "clone-voice";
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[tts]
voice_id = "\${ELEVENLABS_VOICE_ID:-}"
`),
		);

		const config = await loadConfig(workspacePath);

		assert.equal(config.tts.voiceId, "clone-voice");
	});

	it("rejects unsupported tts providers", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		delete process.env.ELEVENLABS_VOICE_ID;
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[tts]
provider = "other"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /tts\.provider/);
	});

	it("loads ElevenLabs voice settings", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		delete process.env.ELEVENLABS_VOICE_ID;
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[tts.voice_settings]
stability = 0.62
similarity_boost = 0.8
style = 0.1
speed = 1.05
use_speaker_boost = false
`),
		);

		const config = await loadConfig(workspacePath);

		assert.deepEqual(config.tts.voiceSettings, {
			stability: 0.62,
			similarityBoost: 0.8,
			style: 0.1,
			speed: 1.05,
			useSpeakerBoost: false,
		});
	});

	it("rejects out-of-range ElevenLabs voice settings", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		delete process.env.ELEVENLABS_VOICE_ID;
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[tts.voice_settings]
stability = 1.1
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /tts\.voice_settings\.stability/);
	});

	it("loads generated media retention settings", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		delete process.env.ELEVENLABS_VOICE_ID;
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[media.generated]
retention_days = 7
`),
		);

		const config = await loadConfig(workspacePath);

		assert.equal(config.media.generatedRetentionDays, 7);
	});
});
