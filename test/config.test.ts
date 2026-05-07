import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { createWorkspace, minimalConfigToml } from "./helpers.js";

describe("loadConfig tts", () => {
	it("uses ElevenLabs defaults when tts config is omitted", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(minimalConfigToml());

		const config = await loadConfig(workspacePath);

		assert.equal(config.tts.provider, "elevenlabs");
		assert.equal(config.tts.apiKeyEnv, "ELEVENLABS_API_KEY");
		assert.equal(config.tts.voiceId, "");
		assert.equal(config.tts.modelId, "eleven_multilingual_v2");
		assert.equal(config.tts.outputFormat, "mp3_44100_128");
		assert.equal(config.tts.maxInputChars, 5000);
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
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[tts]
provider = "other"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /tts\.provider/);
	});
});
