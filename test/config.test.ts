import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadConfig } from "../src/config/index.js";
import { createConfiguredModel } from "../src/models/index.js";
import { resolveOpenRouterRouting } from "../src/models/openrouter-routing.js";
import { createWorkspace, minimalConfigToml, withDiscordToken, withoutEnv } from "./helpers.js";

describe("loadConfig platform setup", () => {
	it("loads without a Discord section or token", async (t) => {
		await withoutEnv("DISCORD_TOKEN", async () => {
			const workspacePath = await createWorkspace(
				t,
				`[agent]
model = "anthropic/claude-sonnet-4-5"
`,
			);
			const config = await loadConfig(workspacePath);

			assert.equal(config.discord.token, undefined);
			assert.equal(config.discord.ownerId, undefined);
			assert.equal(config.defaultPlatform, undefined);
		});
	});

	it("requires Discord owner_id when a token is configured", async (t) => {
		await withDiscordToken(async () => {
			const workspacePath = await createWorkspace(
				t,
				`[agent]
model = "anthropic/claude-sonnet-4-5"
`,
			);

			await assert.rejects(() => loadConfig(workspacePath), /discord\.owner_id/);
		});
	});

	it("requires qq.owner_id when qq.ws_url is set and parses the qq section", async (t) => {
		await withoutEnv("DISCORD_TOKEN", async () => {
			const missingOwnerPath = await createWorkspace(
				t,
				`[agent]
model = "anthropic/claude-sonnet-4-5"

[qq]
ws_url = "ws://127.0.0.1:3001"
`,
			);
			await assert.rejects(() => loadConfig(missingOwnerPath), /qq\.owner_id/);

			const workspacePath = await createWorkspace(
				t,
				`[agent]
model = "anthropic/claude-sonnet-4-5"

[qq]
ws_url = "ws://127.0.0.1:3001"
owner_id = "10001"
allowed_groups = ["30003"]
`,
			);
			const config = await loadConfig(workspacePath);
			assert.equal(config.qq.wsUrl, "ws://127.0.0.1:3001");
			assert.equal(config.qq.ownerId, "10001");
			assert.deepEqual(config.qq.allowedGroups, ["30003"]);

			const emptyConfigPath = await createWorkspace(
				t,
				`[agent]
model = "anthropic/claude-sonnet-4-5"
`,
			);
			const emptyConfig = await loadConfig(emptyConfigPath);
			assert.equal(emptyConfig.qq.wsUrl, undefined);
			assert.deepEqual(emptyConfig.qq.allowedGroups, []);
		});
	});

	it("validates default_platform", async (t) => {
		const workspacePath = await createWorkspace(
			t,
			`default_platform = "qq"

[agent]
model = "anthropic/claude-sonnet-4-5"
`,
		);
		const config = await withoutEnv("DISCORD_TOKEN", () => loadConfig(workspacePath));
		assert.equal(config.defaultPlatform, "qq");

		const invalidWorkspacePath = await createWorkspace(
			t,
			`default_platform = "matrix"

[agent]
model = "anthropic/claude-sonnet-4-5"
`,
		);
		await withoutEnv("DISCORD_TOKEN", async () => {
			await assert.rejects(() => loadConfig(invalidWorkspacePath), /default_platform/);
		});
	});
});

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

	it("uses ElevenLabs defaults when tts config is omitted", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		delete process.env.ELEVENLABS_VOICE_ID;
		const workspacePath = await createWorkspace(t, minimalConfigToml());

		const config = await loadConfig(workspacePath);

		assert.equal(config.tts.provider, "elevenlabs");
		assert.equal(config.tts.apiKeyEnv, "ELEVENLABS_API_KEY");
		assert.equal(config.tts.voiceId, "");
		assert.equal(config.tts.modelId, "eleven_multilingual_v2");
		assert.equal(config.tts.outputFormat, "mp3_44100_128");
		assert.equal(config.tts.maxInputChars, 5000);
		assert.deepEqual(config.tts.cartesia, {
			apiKeyEnv: "CARTESIA_API_KEY",
			voiceId: "",
			modelId: "sonic-3.5",
		});
		assert.deepEqual(config.imageGen, {
			enabled: true,
			model: "openrouter/google/gemini-2.5-flash-image",
			fallbackModel: undefined,
			api: "openrouter-images",
			timeoutMs: 120000,
		});
		assert.equal(config.media.generatedRetentionDays, 30);
		assert.deepEqual(config.data, {
			chat: { retentionDays: 0 },
			transcripts: { retentionDays: 0 },
			payloads: { retentionDays: 7 },
		});
		assert.deepEqual(config.heartbeat, {
			enabled: false,
			idleThresholdMs: 60 * 60_000,
			intervalMs: 240 * 60_000,
		});
		assert.deepEqual(config.cron, {
			enabled: false,
			pollMs: 60_000,
			jobs: [],
		});
		assert.deepEqual(config.browser, {
			enabled: false,
			backend: "opencli",
			harnessTarget: { mode: "attach" },
			opencliCommand: "opencli",
			harnessCommand: "browser-harness",
			session: "familiar",
			profile: undefined,
			windowMode: "background",
			timeoutMs: 60_000,
			maxOutputChars: 12_000,
			readWrite: false,
			allowedSites: config.browser.allowedSites,
		});
		assert.deepEqual(config.tts.voiceSettings, {
			stability: 0.5,
			similarityBoost: 0.75,
			style: 0,
			speed: 1,
			useSpeakerBoost: true,
		});
	});

	it("accepts max agent thinking", async (t) => {
		const workspacePath = await createWorkspace(t, minimalConfigToml('thinking_level = "max"'));

		const config = await withDiscordToken(() => loadConfig(workspacePath));

		assert.equal(config.agent.thinkingLevel, "max");
	});

	it("interpolates voice id from the environment", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		process.env.ELEVENLABS_VOICE_ID = "clone-voice";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[tts]
voice_id = "\${ELEVENLABS_VOICE_ID:-}"
`),
		);

		const config = await loadConfig(workspacePath);

		assert.equal(config.tts.voiceId, "clone-voice");
	});

	it("rejects unsupported tts providers", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		delete process.env.ELEVENLABS_VOICE_ID;
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[tts]
provider = "other"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /tts\.provider/);
	});

	it("loads the cartesia provider config", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		delete process.env.ELEVENLABS_VOICE_ID;
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[tts]
provider = "cartesia"

[tts.cartesia]
api_key_env = "MY_CARTESIA_KEY"
voice_id = "cartesia-voice"
model_id = "sonic-3"
`),
		);

		const config = await loadConfig(workspacePath);

		assert.equal(config.tts.provider, "cartesia");
		assert.deepEqual(config.tts.cartesia, {
			apiKeyEnv: "MY_CARTESIA_KEY",
			voiceId: "cartesia-voice",
			modelId: "sonic-3",
		});
	});

	it("loads ElevenLabs voice settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		delete process.env.ELEVENLABS_VOICE_ID;
		const workspacePath = await createWorkspace(
			t,
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

	it("rejects out-of-range ElevenLabs voice settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		delete process.env.ELEVENLABS_VOICE_ID;
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[tts.voice_settings]
stability = 1.1
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /tts\.voice_settings\.stability/);
	});

	it("loads browser settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
	const workspacePath = await createWorkspace(
		t,
		minimalConfigToml(`
	[browser]
	enabled = true
	opencli_command = "opencli-dev"
	session = "familiar-main"
	profile = "work"
	window = "foreground"
	timeout_ms = 120000
	max_output_chars = 9000
	read_write = true
	`),
	);

		const config = await loadConfig(workspacePath);

		assert.equal(config.browser.enabled, true);
		assert.equal(config.browser.backend, "opencli");
		assert.equal(config.browser.opencliCommand, "opencli-dev");
		assert.equal(config.browser.harnessCommand, "browser-harness");
		assert.equal(config.browser.session, "familiar-main");
		assert.equal(config.browser.profile, "work");
		assert.equal(config.browser.windowMode, "foreground");
		assert.equal(config.browser.timeoutMs, 120000);
		assert.equal(config.browser.maxOutputChars, 9000);
		assert.equal(config.browser.readWrite, true);
		assert.equal(config.browser.allowedSites.twitter, true);
		assert.equal(config.browser.allowedSites.reddit, true);
		assert.equal(config.browser.allowedSites.youtube, true);
		assert.equal(config.browser.allowedSites.spotify, true);
	});

	it("loads browser-harness browser backend settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
	[browser]
	enabled = true
	backend = "browser-harness"
	harness_mode = "cloud"
	harness_command = "browser-harness-dev"
	session = "personal"
	harness_cloud_api_key_env = "ALT_BROWSER_USE_API_KEY"
	harness_cloud_profile_id = "profile-123"
	harness_cloud_timeout_minutes = 120
	harness_cloud_proxy_country_code = "de"
	`),
		);

		const config = await loadConfig(workspacePath);

		assert.equal(config.browser.backend, "browser-harness");
		assert.deepEqual(config.browser.harnessTarget, {
			mode: "cloud",
			apiKeyEnv: "ALT_BROWSER_USE_API_KEY",
			profileId: "profile-123",
			profileName: undefined,
			timeoutMinutes: 120,
			proxyCountryCode: "de",
		});
		assert.equal(config.browser.opencliCommand, "opencli");
		assert.equal(config.browser.harnessCommand, "browser-harness-dev");
		assert.equal(config.browser.session, "personal");
	});

	it("loads browser-harness cdp launch settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
	[browser]
	enabled = true
	backend = "browser-harness"
	harness_mode = "cdp"
	harness_cdp_url = "http://127.0.0.1:9222"
	harness_launch_command = "/usr/bin/chromium"
	harness_launch_args = [
		"--headless=new",
		"--remote-debugging-port=9222",
	]
	`),
		);

		const config = await loadConfig(workspacePath);

		assert.deepEqual(config.browser.harnessTarget, {
			mode: "cdp",
			cdpUrl: "http://127.0.0.1:9222",
			cdpWs: undefined,
			launchCommand: "/usr/bin/chromium",
			launchArgs: ["--headless=new", "--remote-debugging-port=9222"],
		});
	});

	it("rejects invalid browser-harness target combinations", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const cases = [
			{
				toml: `
	[browser]
	harness_mode = "cdp"
	harness_cdp_url = "http://127.0.0.1:9222"
	harness_cdp_ws = "ws://127.0.0.1:9222/devtools/browser/local"
	`,
				pattern: /harness_cdp_url or browser\.harness_cdp_ws/,
			},
			{
				toml: `
	[browser]
	harness_mode = "cdp"
	`,
				pattern: /requires browser\.harness_cdp_url or browser\.harness_cdp_ws/,
			},
			{
				toml: `
	[browser]
	harness_mode = "cloud"
	harness_cloud_profile_id = "profile-1"
	harness_cloud_profile_name = "work"
	`,
				pattern: /harness_cloud_profile_id or browser\.harness_cloud_profile_name/,
			},
			{
				toml: `
	[browser]
	harness_mode = "attach"
	harness_cdp_url = "http://127.0.0.1:9222"
	`,
				pattern: /harness_cdp_url.*harness_mode = "cdp"/,
			},
			{
				toml: `
	[browser]
	harness_mode = "cdp"
	harness_cdp_ws = "ws://127.0.0.1:9222/devtools/browser/local"
	harness_launch_command = "/usr/bin/chromium"
	`,
				pattern: /harness_launch_command requires browser\.harness_cdp_url/,
			},
		];

		for (const item of cases) {
			const workspacePath = await createWorkspace(t, minimalConfigToml(item.toml));
			await assert.rejects(() => loadConfig(workspacePath), item.pattern);
		}
	});

	it("rejects invalid browser settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
	[browser]
	backend = "other"
	`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /browser\.backend/);
	});

	it("rejects legacy browser site command filters", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
	[browser.sites.twitter]
	read = ["timeline"]
	write = ["post"]
	description = "legacy site config"
	`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /browser\.sites/);
	});

	it("loads generated media retention settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		delete process.env.ELEVENLABS_VOICE_ID;
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[media.generated]
retention_days = 7
`),
		);

		const config = await loadConfig(workspacePath);

		assert.equal(config.media.generatedRetentionDays, 7);
	});

	it("loads image generation settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[image_gen]
enabled = false
model = "custom/gemini-image"
fallback_model = "openrouter/openai/gpt-5-image"
api = "openrouter-images"
timeout_ms = 90000
`),
		);

		const config = await loadConfig(workspacePath);

		assert.deepEqual(config.imageGen, {
			enabled: false,
			model: "custom/gemini-image",
			fallbackModel: "openrouter/openai/gpt-5-image",
			api: "openrouter-images",
			timeoutMs: 90000,
		});
	});

	it("rejects unsupported image generation API shapes", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[image_gen]
api = "native-gemini"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /image_gen\.api/);
	});

	it("loads media understanding defaults", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(t, minimalConfigToml());

		const config = await loadConfig(workspacePath);

		assert.deepEqual(config.mediaUnderstanding.audio, {
			provider: "groq",
			model: "whisper-large-v3",
			apiKeyEnv: "GROQ_API_KEY",
		});
		assert.deepEqual(config.mediaUnderstanding.video, {
			provider: "google",
			model: "gemini-3-flash-preview",
			baseUrl: undefined,
			apiKeyEnv: "GEMINI_API_KEY",
		});
	});

	it("loads media understanding video base URL override", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[media.understanding.video]
base_url = "https://generativelanguage.googleapis.com/v1beta"
api_key_env = "ALT_GEMINI_KEY"
`),
		);

		const config = await loadConfig(workspacePath);

		assert.deepEqual(config.mediaUnderstanding.video, {
			provider: "google",
			model: "gemini-3-flash-preview",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			apiKeyEnv: "ALT_GEMINI_KEY",
		});
	});

	it("loads memory defaults under the workspace root", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(t, minimalConfigToml());

		const config = await loadConfig(workspacePath);

		assert.equal(config.memory.rootDir, resolve(workspacePath, "memories"));
		assert.equal(config.memory.indexDir, resolve(workspacePath, "memories", "index"));
		assert.equal(config.memory.lcmDir, resolve(workspacePath, "memories", "lcm"));
		assert.equal(config.memory.diariesDir, resolve(workspacePath, "memories", "diaries"));
		assert.equal(config.memory.archiveDir, resolve(workspacePath, "memories", "archive"));
		assert.deepEqual(config.memory.embedding, {
			format: "gemini",
			provider: "google",
			model: "gemini-embedding-2",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			apiKeyEnv: "GEMINI_API_KEY",
			dimensions: 3072,
			batchSize: 32,
		});
		assert.deepEqual(config.memory.ambient, {
			enabled: true,
			topK: 3,
			minQueryLength: 8,
			throttleSeconds: 30,
			weightSimilarity: 1,
			weightValence: 0.08,
			weightRecency: 0.08,
			weightIntensity: 0.1,
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
			maxSummaryDepth: 2,
			maxRounds: 10,
			cacheTtlMs: 300000,
			cacheTouchSlackMs: 30000,
			criticalOverflowTokens: 8000,
			timeoutMs: 60000,
		});
	});

	it("loads the shipped example config", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(t, await readFile(resolve("config.example.toml"), "utf8"));

		const config = await loadConfig(workspacePath);

		assert.equal(config.agent.model, "anthropic/claude-fable-5");
		assert.equal(config.agent.cacheRetention, "short");
		assert.equal(config.discord.chunkMode, "newline");
		assert.deepEqual(config.browser, {
			enabled: false,
			backend: "browser-harness",
			harnessTarget: { mode: "attach" },
			opencliCommand: "opencli",
			harnessCommand: "browser-harness",
			session: "familiar",
			profile: undefined,
			windowMode: "foreground",
			timeoutMs: 60_000,
			maxOutputChars: 12_000,
			readWrite: true,
			allowedSites: config.browser.allowedSites,
		});
		assert.equal(config.heartbeat.enabled, false);
		assert.equal(config.models.baseUrls.link, "https://api.linkapi.ai/v1");
		assert.equal(config.models.apiKeyEnvs.link, "LINK_API_KEY");
		assert.deepEqual(config.models.providers, {});
		assert.deepEqual(config.imageGen, {
			enabled: true,
			model: "link/gpt-image-2-c",
			fallbackModel: "link/gemini-3-pro-image-preview",
			api: "openrouter-images",
			timeoutMs: 120000,
		});
		assert.equal(config.memory.lcm.model, "anthropic/claude-fable-5");
		for (const model of [config.agent.model, config.memory.lcm.model, config.imageGen.model, config.imageGen.fallbackModel]) {
			assert.ok(model === undefined || config.models.allow.includes(model));
		}
	});

	it("loads heartbeat settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[heartbeat]
enabled = true
idle_threshold_minutes = 30
interval_minutes = 90
`),
		);

		const config = await loadConfig(workspacePath);

		assert.deepEqual(config.heartbeat, {
			enabled: true,
			idleThresholdMs: 30 * 60_000,
			intervalMs: 90 * 60_000,
		});
	});

	it("loads cron jobs", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[cron]
enabled = true
poll_seconds = 30

[[cron.jobs]]
id = "daily-review"
frequency = "daily"
delivery_mode = "queue"
time = "09:00"
prompt = "Review today's priorities."

[[cron.jobs]]
id = "one-shot"
enabled = false
frequency = "once"
delivery_mode = "follow_up"
run_at = "2026-05-13 23:00"
prompt = "Remember this once."
`),
		);

		const config = await loadConfig(workspacePath);

		assert.deepEqual(config.cron, {
			enabled: true,
			pollMs: 30_000,
			jobs: [
				{
					id: "daily-review",
					enabled: true,
					frequency: "daily",
					deliveryMode: "queue",
					time: "09:00",
					prompt: "Review today's priorities.",
				},
				{
					id: "one-shot",
					enabled: false,
					frequency: "once",
					deliveryMode: "follow_up",
					runAt: "2026-05-13 23:00",
					prompt: "Remember this once.",
				},
			],
		});
	});

	it("rejects invalid cron jobs", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[cron]
enabled = true

[[cron.jobs]]
id = "bad job"
frequency = "daily"
time = "09:00"
prompt = "Bad id."
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /cron\.jobs\[0\]\.id/);
	});

	it("rejects once cron jobs with repeating time", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[cron]
enabled = true

[[cron.jobs]]
id = "one-shot"
frequency = "once"
run_at = "2026-05-13 23:00"
time = "09:00"
prompt = "Conflicting schedule."
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /cron\.jobs\[0\]\.time/);
	});

	it("rejects invalid cron time strings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[cron]
enabled = true

[[cron.jobs]]
id = "daily-review"
frequency = "daily"
time = "25:00"
prompt = "Bad time."
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /HH:MM local time/);
	});

	it("loads memory overrides", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[memory]
root_dir = "brain"

[memory.embedding]
format = "gemini"
provider = "google"
model = "custom-embedding"
base_url = "https://memory.example.test/v1beta"
api_key_env = "CUSTOM_EMBEDDING_KEY"
dimensions = 1536
batch_size = 8

[memory.ambient]
enabled = false
top_k = 5
min_query_length = 12
throttle_seconds = 60
weight_similarity = 0.5
weight_valence = 0.2
weight_recency = 0.3
weight_intensity = 0.4

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
			format: "gemini",
			provider: "google",
			model: "custom-embedding",
			baseUrl: "https://memory.example.test/v1beta",
			apiKeyEnv: "CUSTOM_EMBEDDING_KEY",
			dimensions: 1536,
			batchSize: 8,
		});
		assert.deepEqual(config.memory.ambient, {
			enabled: false,
			topK: 5,
			minQueryLength: 12,
			throttleSeconds: 60,
			weightSimilarity: 0.5,
			weightValence: 0.2,
			weightRecency: 0.3,
			weightIntensity: 0.4,
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

	it("inherits memory embedding provider settings from configured models", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[models.base_urls]
google = "https://gateway.example.test/google"
"google/gemini-embedding-2" = "https://gateway.example.test/google-embedding"

[models.api_key_envs]
google = "GOOGLE_GATEWAY_KEY"
"google/gemini-embedding-2" = "GOOGLE_EMBEDDING_KEY"

[memory.embedding]
format = "gemini"
provider = "google"
model = "gemini-embedding-2"
`),
		);

		const config = await loadConfig(workspacePath);

		assert.equal(config.memory.embedding.baseUrl, "https://gateway.example.test/google-embedding");
		assert.equal(config.memory.embedding.apiKeyEnv, "GOOGLE_EMBEDDING_KEY");
	});

	it("configures OpenRouter routing with model-specific precedence", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			`
[discord]
owner_id = "owner"

[agent]
model = "anthropic/claude-fable-5"

[models.base_urls]
anthropic = "https://openrouter.ai/api/"

[models.openrouter_routing]
anthropic = { order = ["anthropic"], allow_fallbacks = true }
"anthropic/claude-fable-5" = { order = ["anthropic"], allow_fallbacks = false }
`,
		);

		const config = await loadConfig(workspacePath);
		const model = createConfiguredModel(config);

		assert.deepEqual(config.models.openRouterRouting, {
			anthropic: { order: ["anthropic"], allowFallbacks: true },
			"anthropic/claude-fable-5": { order: ["anthropic"], allowFallbacks: false },
		});
		assert.deepEqual(resolveOpenRouterRouting(config, model), {
			order: ["anthropic"],
			allowFallbacks: false,
		});
		assert.equal(model.baseUrl, "https://openrouter.ai/api/");
		assert.equal((model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking, true);
	});

	it("rejects OpenRouter routing for non-OpenRouter base URLs", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[models.openrouter_routing]
anthropic = { order = ["anthropic"] }
`),
		);

		await assert.rejects(
			() => loadConfig(workspacePath),
			/models\.openrouter_routing\.anthropic requires its models\.base_urls target to be https:\/\/openrouter\.ai\/api/,
		);
	});

	it("rejects provider-wide routing over a model-specific non-OpenRouter URL", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[models.base_urls]
anthropic = "https://openrouter.ai/api"
"anthropic/claude-sonnet-4-5" = "https://api.anthropic.com"

[models.openrouter_routing]
anthropic = { order = ["anthropic"] }
`),
		);

		await assert.rejects(
			() => loadConfig(workspacePath),
			/models\.openrouter_routing\.anthropic applies to anthropic\/claude-sonnet-4-5/,
		);
	});

	it("supports custom providers with provider-level defaults and no explicit model list", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			`
[discord]
owner_id = "owner"

[agent]
model = "proxy/claude-sonnet-4"

[models.base_urls]
proxy = "https://proxy.example.com"

[models.api_key_envs]
proxy = "PROXY_API_KEY"

[models.providers.proxy]
api = "anthropic-messages"
reasoning = true
input = ["text", "image"]
context_window = 200000
max_tokens = 8192
compat = { send_session_affinity_headers = true, supports_eager_tool_input_streaming = false, supports_cache_control_on_tools = false }
`,
		);

		const config = await loadConfig(workspacePath);
		const model = createConfiguredModel(config);

		assert.deepEqual(config.models.providers.proxy, {
			api: "anthropic-messages",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200000,
			maxTokens: 8192,
			compat: {
				sendSessionAffinityHeaders: true,
				supportsEagerToolInputStreaming: false,
				supportsCacheControlOnTools: false,
			},
			models: [],
		});
		assert.equal(model.provider, "proxy");
		assert.equal(model.id, "claude-sonnet-4");
		assert.equal(model.api, "anthropic-messages");
		assert.equal(model.baseUrl, "https://proxy.example.com");
		assert.equal(model.reasoning, true);
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.contextWindow, 200000);
		assert.equal(model.maxTokens, 8192);
		assert.deepEqual(model.compat, {
			sendSessionAffinityHeaders: true,
			supportsEagerToolInputStreaming: false,
			supportsCacheControlOnTools: false,
		});
	});

	it("inherits provider compat onto configured model overrides", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			`
[discord]
owner_id = "owner"

[agent]
model = "proxy/claude-opus-4"

[models.base_urls]
proxy = "https://proxy.example.com"

[models.api_key_envs]
proxy = "PROXY_API_KEY"

[models.providers.proxy]
api = "anthropic-messages"
compat = { send_session_affinity_headers = true, supports_eager_tool_input_streaming = false }

[[models.providers.proxy.models]]
id = "claude-opus-4"
name = "Claude Opus 4 via Proxy"
compat = { supports_cache_control_on_tools = false, allow_empty_signature = true }
`,
		);

		const config = await loadConfig(workspacePath);
		const model = createConfiguredModel(config);

		assert.deepEqual(model.compat, {
			sendSessionAffinityHeaders: true,
			supportsEagerToolInputStreaming: false,
			supportsCacheControlOnTools: false,
			allowEmptySignature: true,
		});
	});

	it("rejects compat for non-Anthropic custom providers", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			`
[discord]
owner_id = "owner"

[agent]
model = "proxy/claude-opus-4"

[models.base_urls]
proxy = "https://proxy.example.com"

[models.api_key_envs]
proxy = "PROXY_API_KEY"

[models.providers.proxy]
api = "openai-completions"
compat = { send_session_affinity_headers = true }
`,
		);

		await assert.rejects(
			() => loadConfig(workspacePath),
			/Config value models\.providers\.proxy\.compat is only valid when models\.providers\.proxy\.api = "anthropic-messages"/,
		);
	});

	it("rejects models.providers entries for built-in providers", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[models.providers.anthropic]
api = "anthropic-messages"
`),
		);

		await assert.rejects(
			() => loadConfig(workspacePath),
			/models\.providers\.anthropic is only for custom providers/,
		);
	});

	it('rejects models.providers entries whose provider name contains "/"', async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[models.providers."custom/proxy"]
api = "anthropic-messages"
`),
		);

		await assert.rejects(
			() => loadConfig(workspacePath),
			/provider name must not contain "\/"; use a bare provider name/,
		);
	});

	it("applies optional per-model overrides under models.providers.<provider>.models", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			`
[discord]
owner_id = "owner"

[agent]
model = "proxy/claude-opus-4"

[models.base_urls]
proxy = "https://proxy.example.com"

[models.api_key_envs]
proxy = "PROXY_API_KEY"

[models.providers.proxy]
api = "anthropic-messages"
reasoning = true
input = ["text", "image"]
context_window = 200000
max_tokens = 8192
compat = { send_session_affinity_headers = true, supports_eager_tool_input_streaming = false }

[[models.providers.proxy.models]]
id = "claude-opus-4"
name = "Claude Opus 4 via Proxy"
max_tokens = 4096
compat = { supports_cache_control_on_tools = false, allow_empty_signature = true }
`,
		);

		const config = await loadConfig(workspacePath);
		const model = createConfiguredModel(config);

		assert.equal(model.provider, "proxy");
		assert.equal(model.id, "claude-opus-4");
		assert.equal(model.api, "anthropic-messages");
		assert.equal(model.baseUrl, "https://proxy.example.com");
		assert.equal(model.name, "Claude Opus 4 via Proxy");
		assert.equal(model.reasoning, true);
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.contextWindow, 200000);
		assert.equal(model.maxTokens, 4096);
		assert.deepEqual(model.compat, {
			sendSessionAffinityHeaders: true,
			supportsEagerToolInputStreaming: false,
			supportsCacheControlOnTools: false,
			allowEmptySignature: true,
		});
	});

	it("inherits memory lcm summarization provider settings from configured models", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
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

	it("rejects direct memory lcm connection settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[memory.lcm]
model = "anthropic/claude-sonnet-4-5"
base_url = "https://summary.example.test"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /memory\.lcm\.base_url/);
	});

	it("requires memory lcm model to be allowlisted when models.allow is set", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[models]
allow = ["anthropic/claude-sonnet-4-5"]

[memory.lcm]
model = "google/gemini-3-flash-preview"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /memory\.lcm\.model is not in models\.allow/);
	});

	it("skips memory lcm model validation when lcm is disabled", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[models]
allow = ["anthropic/claude-sonnet-4-5"]

[memory.lcm]
enabled = false
model = "local-summary"
leaf_chunk_tokens = 0
leaf_target_tokens = 999999
prompt = 42
`),
		);

		const config = await loadConfig(workspacePath);

		assert.equal(config.memory.lcm.enabled, false);
		assert.equal(config.memory.lcm.model, "local-summary");
		assert.equal(config.memory.lcm.provider, "");
		assert.equal(config.memory.lcm.modelId, "");
		assert.equal(config.memory.lcm.leafChunkTokens, 20000);
		assert.equal(config.memory.lcm.leafTargetTokens, 2400);
		assert.equal(config.memory.lcm.prompt, undefined);
	});

	it("allows custom memory embedding providers with explicit connection settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[memory.embedding]
format = "gemini"
provider = "local-gateway"
model = "media-embed"
base_url = "http://localhost:8788/v1"
api_key_env = "LOCAL_GATEWAY_KEY"
`),
		);

		const config = await loadConfig(workspacePath);

		assert.deepEqual(config.memory.embedding, {
			format: "gemini",
			provider: "local-gateway",
			model: "media-embed",
			baseUrl: "http://localhost:8788/v1",
			apiKeyEnv: "LOCAL_GATEWAY_KEY",
			dimensions: 3072,
			batchSize: 32,
		});
	});

	it("rejects invalid memory numeric settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[memory.embedding]
dimensions = 0

[memory.lcm]
new_session_retain_depth = -2
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /memory\.embedding\.dimensions/);
	});

	it("rejects invalid memory lcm settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[memory.lcm]
context_threshold = 1.25
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /memory\.lcm\.context_threshold/);
	});

	it("rejects unknown memory lcm settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[memory.lcm]
enabled = true
surprise = "nope"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /memory\.lcm\.surprise/);
	});

	it("loads memory lcm cache and overflow settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[memory.lcm]
cache_ttl_ms = 123456
cache_touch_slack_ms = 23456
critical_overflow_tokens = 3456
`),
		);

		const config = await loadConfig(workspacePath);

		assert.equal(config.memory.lcm.cacheTtlMs, 123456);
		assert.equal(config.memory.lcm.cacheTouchSlackMs, 23456);
		assert.equal(config.memory.lcm.criticalOverflowTokens, 3456);
	});

	it("rejects conflicting memory lcm prompts", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[memory.lcm]
prompt = "inline"
prompt_path = "prompt.md"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /prompt or memory\.lcm\.prompt_path/);
	});

	it("rejects unsupported memory embedding apis", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[memory.embedding]
format = "invalid"
provider = "openai"
base_url = "https://api.openai.com/v1"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /memory\.embedding\.format/);
	});

	it("rejects deprecated memory embedding api alias", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[memory.embedding]
api = "openai"
provider = "openai"
base_url = "https://api.openai.com/v1"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /Unknown config value: memory\.embedding\.api/);
	});

	it("loads snake_case agent cache retention and rejects deprecated camelCase alias", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const canonicalWorkspace = await createWorkspace(
			t,
			minimalConfigToml(`
cache_retention = "short"
`),
		);
		const legacyWorkspace = await createWorkspace(
			t,
			minimalConfigToml(`
cacheRetention = "none"
`),
		);

		assert.equal((await loadConfig(canonicalWorkspace)).agent.cacheRetention, "short");
		await assert.rejects(() => loadConfig(legacyWorkspace), /Unknown config value: agent\.cacheRetention/);
	});

	it("rejects legacy manual agent model settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
api = "anthropic-messages"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /Unknown config value: agent\.api/);
	});

	it("loads data retention settings", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[data.chat]
retention_days = 14

[data.transcripts]
retention_days = 30

[data.payloads]
retention_days = 3
`),
		);

		const config = await loadConfig(workspacePath);

		assert.deepEqual(config.data, {
			chat: { retentionDays: 14 },
			transcripts: { retentionDays: 30 },
			payloads: { retentionDays: 3 },
		});
	});

	it("rejects custom memory embedding providers without a base url", async (t) => {
		process.env.DISCORD_TOKEN = "discord-token";
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[memory.embedding]
provider = "local-gateway"
model = "media-embed"
`),
		);

		await assert.rejects(() => loadConfig(workspacePath), /memory\.embedding\.base_url/);
	});
});
