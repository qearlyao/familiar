import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { resolve } from "node:path";

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

	it("loads media understanding defaults", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(minimalConfigToml());

		const config = await loadConfig(workspacePath);

		assert.deepEqual(config.mediaUnderstanding.audio, {
			provider: "groq",
			model: "whisper-large-v3",
			apiKeyEnv: "GROQ_API_KEY",
		});
		assert.deepEqual(config.mediaUnderstanding.video, {
			provider: "google",
			model: "gemini-3-flash-preview",
			apiKeyEnv: "GEMINI_API_KEY",
		});
	});

	it("loads memory defaults under the workspace root", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(minimalConfigToml());

		const config = await loadConfig(workspacePath);

		assert.equal(config.memory.rootDir, resolve(workspacePath, "memories"));
		assert.equal(config.memory.indexDir, resolve(workspacePath, "memories", "index"));
		assert.equal(config.memory.lcmDir, resolve(workspacePath, "memories", "lcm"));
		assert.equal(config.memory.diariesDir, resolve(workspacePath, "memories", "diaries"));
		assert.equal(config.memory.archiveDir, resolve(workspacePath, "memories", "archive"));
		assert.deepEqual(config.memory.embedding, {
			api: "gemini",
			provider: "google",
			model: "gemini-embedding-2",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			apiKeyEnv: "GEMINI_API_KEY",
			dimensions: 3072,
			batchSize: 32,
		});
		assert.equal(config.memory.lcm.newSessionRetainDepth, 2);
	});

	it("loads memory overrides", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[memory]
root_dir = "brain"

[memory.embedding]
api = "gemini"
provider = "google"
model = "custom-embedding"
base_url = "https://memory.example.test/v1beta"
api_key_env = "CUSTOM_EMBEDDING_KEY"
dimensions = 1536
batch_size = 8

[memory.lcm]
new_session_retain_depth = -1
`),
		);

		const config = await loadConfig(workspacePath);

		assert.equal(config.memory.rootDir, resolve(workspacePath, "brain"));
		assert.deepEqual(config.memory.embedding, {
			api: "gemini",
			provider: "google",
			model: "custom-embedding",
			baseUrl: "https://memory.example.test/v1beta",
			apiKeyEnv: "CUSTOM_EMBEDDING_KEY",
			dimensions: 1536,
			batchSize: 8,
		});
		assert.equal(config.memory.lcm.newSessionRetainDepth, -1);
	});

	it("inherits memory embedding provider settings from configured models", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[models.base_urls]
google = "https://gateway.example.test/google"
"google/gemini-embedding-2" = "https://gateway.example.test/google-embedding"

[models.api_key_envs]
google = "GOOGLE_GATEWAY_KEY"
"google/gemini-embedding-2" = "GOOGLE_EMBEDDING_KEY"

[memory.embedding]
api = "gemini"
provider = "google"
model = "gemini-embedding-2"
`),
		);

		const config = await loadConfig(workspacePath);

		assert.equal(config.memory.embedding.baseUrl, "https://gateway.example.test/google-embedding");
		assert.equal(config.memory.embedding.apiKeyEnv, "GOOGLE_EMBEDDING_KEY");
	});

	it("allows custom memory embedding providers with explicit connection settings", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[memory.embedding]
api = "gemini"
provider = "local-gateway"
model = "media-embed"
base_url = "http://localhost:8788/v1"
api_key_env = "LOCAL_GATEWAY_KEY"
`),
		);

		const config = await loadConfig(workspacePath);

		assert.deepEqual(config.memory.embedding, {
			api: "gemini",
			provider: "local-gateway",
			model: "media-embed",
			baseUrl: "http://localhost:8788/v1",
			apiKeyEnv: "LOCAL_GATEWAY_KEY",
			dimensions: 3072,
			batchSize: 32,
		});
	});

	it("rejects invalid memory numeric settings", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[memory.embedding]
dimensions = 0

[memory.lcm]
new_session_retain_depth = -2
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /memory\.embedding\.dimensions/);
	});

	it("rejects unsupported memory embedding apis", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[memory.embedding]
api = "openai"
provider = "openai"
base_url = "https://api.openai.com/v1"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /memory\.embedding\.api/);
	});

	it("rejects custom memory embedding providers without a base url", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[memory.embedding]
provider = "local-gateway"
model = "media-embed"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /memory\.embedding\.base_url/);
	});
});
