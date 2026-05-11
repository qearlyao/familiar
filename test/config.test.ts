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
		assert.deepEqual(config.memory.lcm, {
			newSessionRetainDepth: 2,
			enabled: true,
			model: "anthropic/claude-sonnet-4-5",
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
			contextThreshold: 0.75,
			freshTailCount: 64,
			leafChunkTokens: 20000,
			leafTargetTokens: 2400,
			promptAwareEvictionEnabled: true,
			condenseGroupSize: 4,
			maxSummaryDepth: 4,
			maxRounds: 10,
			cacheTtlMs: 300000,
			cacheTouchSlackMs: 30000,
			criticalOverflowTokens: 8000,
			timeoutMs: 60000,
		});
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
enabled = true
model = "google/gemini-3-flash-preview"
context_threshold = 0.8
fresh_tail_count = 5
fresh_tail_max_tokens = 1200
leaf_chunk_tokens = 16000
leaf_target_tokens = 700
prompt_aware_eviction_enabled = false
condense_group_size = 3
max_summary_depth = 5
new_session_retain_depth = -1
max_rounds = 4
timeout_ms = 45000
prompt = "Summarize this branch."
system_prompt_path = "prompts/lcm-system.md"
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
		assert.deepEqual(config.memory.lcm, {
			newSessionRetainDepth: -1,
			enabled: true,
			model: "google/gemini-3-flash-preview",
			provider: "google",
			modelId: "gemini-3-flash-preview",
			contextThreshold: 0.8,
			freshTailCount: 5,
			freshTailMaxTokens: 1200,
			leafChunkTokens: 16000,
			leafTargetTokens: 700,
			promptAwareEvictionEnabled: false,
			condenseGroupSize: 3,
			maxSummaryDepth: 5,
			maxRounds: 4,
			cacheTtlMs: 300000,
			cacheTouchSlackMs: 30000,
			criticalOverflowTokens: 8000,
			timeoutMs: 45000,
			prompt: "Summarize this branch.",
			systemPromptPath: resolve(workspacePath, "prompts/lcm-system.md"),
		});
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

	it("inherits memory lcm summarization provider settings from configured models", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[models.base_urls]
anthropic = "https://gateway.example.test/anthropic"
"anthropic/claude-sonnet-4-5" = "https://gateway.example.test/summary"

[models.api_key_envs]
anthropic = "ANTHROPIC_GATEWAY_KEY"
"anthropic/claude-sonnet-4-5" = "SUMMARY_GATEWAY_KEY"
`),
		);

		const config = await loadConfig(workspacePath);
		assert.equal(config.memory.lcm.model, "anthropic/claude-sonnet-4-5");
		assert.equal(config.memory.lcm.baseUrl, "https://gateway.example.test/summary");
		assert.equal(config.memory.lcm.apiKeyEnv, "SUMMARY_GATEWAY_KEY");
	});

	it("rejects direct memory lcm connection settings", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[memory.lcm]
model = "anthropic/claude-sonnet-4-5"
base_url = "https://summary.example.test"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /memory\.lcm\.base_url/);
	});

	it("requires memory lcm model to be allowlisted when models.allow is set", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[models]
allow = ["anthropic/claude-sonnet-4-5"]

[memory.lcm]
model = "google/gemini-3-flash-preview"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /memory\.lcm\.model is not in models\.allow/);
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

	it("rejects invalid memory lcm settings", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[memory.lcm]
context_threshold = 1.25
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /memory\.lcm\.context_threshold/);
	});

	it("rejects unknown memory lcm settings", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[memory.lcm]
enabled = true
surprise = "nope"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /memory\.lcm\.surprise/);
	});

	it("rejects conflicting memory lcm prompts", async () => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			minimalConfigToml(`
[memory.lcm]
prompt = "inline"
prompt_path = "prompt.md"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /prompt or memory\.lcm\.prompt_path/);
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
