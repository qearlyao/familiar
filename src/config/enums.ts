import type {
	BrowserBackend,
	BrowserHarnessMode,
	CacheRetention,
	CronDeliveryMode,
	CronFrequency,
	DefaultPlatform,
	DiscordChannelTrigger,
	DiscordChunkMode,
	DiscordDispatchMode,
	DiscordReplyMode,
	ImageGenApi,
	MediaUnderstandingProvider,
	MemoryEmbeddingFormat,
	ThinkingLevel,
	TtsProvider,
	WebAuthMode,
} from "./types.js";

export const CACHE_RETENTIONS = ["none", "short", "long"] as const satisfies readonly CacheRetention[];
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];
export const DISCORD_REPLY_MODES = ["plain", "reply"] as const satisfies readonly DiscordReplyMode[];
export const DISCORD_CHUNK_MODES = ["simple", "paragraph", "newline"] as const satisfies readonly DiscordChunkMode[];
export const DISCORD_DISPATCH_MODES = ["steer", "queue", "collect"] as const satisfies readonly DiscordDispatchMode[];
export const DISCORD_CHANNEL_TRIGGERS = ["mention", "always"] as const satisfies readonly DiscordChannelTrigger[];
export const DEFAULT_PLATFORMS = ["discord", "qq", "web"] as const satisfies readonly DefaultPlatform[];
export const CRON_FREQUENCIES = [
	"once",
	"hourly",
	"daily",
	"weekly",
	"monthly",
] as const satisfies readonly CronFrequency[];
export const CRON_DELIVERY_MODES = ["queue", "follow_up"] as const satisfies readonly CronDeliveryMode[];
export const WEB_AUTH_MODES = ["tailscale-only", "bearer", "public-2fa"] as const satisfies readonly WebAuthMode[];
export const TTS_PROVIDERS = ["elevenlabs", "cartesia"] as const satisfies readonly TtsProvider[];
export const IMAGE_GEN_APIS = [
	"openrouter-images",
	"openai-images",
	"google-images",
] as const satisfies readonly ImageGenApi[];

/**
 * Wire style used when `image_gen.apis` does not name a provider. Providers
 * with a known native image endpoint default to it; everything else keeps the
 * OpenRouter chat-completions shape, which is what gateways proxying an
 * OpenRouter-style route expect.
 */
export const DEFAULT_IMAGE_GEN_API: ImageGenApi = "openrouter-images";

export const DEFAULT_IMAGE_GEN_APIS: Record<string, ImageGenApi> = {
	openai: "openai-images",
	xai: "openai-images",
	google: "google-images",
};
export const MEDIA_UNDERSTANDING_PROVIDERS = [
	"groq",
	"google",
] as const satisfies readonly MediaUnderstandingProvider[];
export const MEMORY_EMBEDDING_FORMATS = [
	"gemini",
	"openai",
	"voyage",
] as const satisfies readonly MemoryEmbeddingFormat[];
export const BROWSER_BACKENDS = ["opencli", "browser-harness"] as const satisfies readonly BrowserBackend[];
export const BROWSER_HARNESS_MODES = ["attach", "cdp", "cloud"] as const satisfies readonly BrowserHarnessMode[];
export const BROWSER_WINDOW_MODES = ["foreground", "background"] as const;
