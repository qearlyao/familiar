export type CacheRetention = "none" | "short" | "long";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type DiscordReplyMode = "plain" | "reply";
export type DiscordChunkMode = "simple" | "paragraph" | "newline";
export type DiscordDispatchMode = "steer" | "queue" | "collect";
export type DiscordChannelTrigger = "mention" | "always";
export type CronFrequency = "once" | "hourly" | "daily" | "weekly" | "monthly";
export type CronDeliveryMode = "queue" | "follow_up";
export type WebAuthMode = "tailscale-only" | "bearer" | "public-2fa";
export type TtsProvider = "elevenlabs";
export type ImageGenApi = "openrouter-images";
export type MediaUnderstandingProvider = "groq" | "google";
export type MemoryEmbeddingFormat = "gemini" | "openai" | "voyage";
export type BrowserBackend = "opencli" | "browser-harness";
export type BrowserHarnessMode = "attach" | "cdp" | "cloud";

export type BrowserHarnessTargetConfig =
	| { mode: "attach" }
	| {
			mode: "cdp";
			cdpUrl?: string;
			cdpWs?: string;
			launchCommand?: string;
			launchArgs: string[];
	  }
	| {
			mode: "cloud";
			apiKeyEnv: string;
			profileId?: string;
			profileName?: string;
			timeoutMinutes?: number;
			proxyCountryCode?: string;
	  };

export interface TtsVoiceSettings {
	stability: number;
	similarityBoost: number;
	style: number;
	speed: number;
	useSpeakerBoost: boolean;
}

export interface Config {
	workspacePath: string;
	discord: {
		token?: string;
		ownerId: string;
		allowedChannels: string[];
		replyMode: DiscordReplyMode;
		chunkMode: DiscordChunkMode;
		dmMode: DiscordDispatchMode;
		channelMode: DiscordDispatchMode;
		channelTrigger: DiscordChannelTrigger;
		collectDebounceMs: number;
		allowBotMessages: boolean;
	};
	web: {
		port: number;
		authMode: WebAuthMode;
		bearerToken?: string;
		totpSecret?: string;
		bindAddress: string;
	};
	browser: {
		enabled: boolean;
		backend: BrowserBackend;
		harnessTarget: BrowserHarnessTargetConfig;
		opencliCommand: string;
		harnessCommand: string;
		session: string;
		profile?: string;
		windowMode: "foreground" | "background";
		timeoutMs: number;
		maxOutputChars: number;
		readWrite: boolean;
		allowedSites: Record<string, true>;
	};
	agent: {
		model: string;
		api?: string;
		modelId?: string;
		baseUrl?: string;
		apiKeyEnv?: string;
		provider?: string;
		cacheRetention: CacheRetention;
		thinkingLevel: ThinkingLevel;
	};
	heartbeat: {
		enabled: boolean;
		idleThresholdMs: number;
		intervalMs: number;
	};
	cron: {
		enabled: boolean;
		pollMs: number;
		jobs: Array<{
			id: string;
			enabled: boolean;
			frequency: CronFrequency;
			deliveryMode: CronDeliveryMode;
			prompt: string;
			runAt?: string;
			time?: string;
			minute?: number;
			weekday?: number;
			day?: number;
		}>;
	};
	models: {
		allow: string[];
		baseUrls: Record<string, string>;
		apiKeyEnvs: Record<string, string>;
	};
	tts: {
		provider: TtsProvider;
		apiKeyEnv: string;
		voiceId: string;
		modelId: string;
		outputFormat: string;
		maxInputChars: number;
		voiceSettings: TtsVoiceSettings;
	};
	imageGen: {
		enabled: boolean;
		model: string;
		fallbackModel?: string;
		api: ImageGenApi;
		timeoutMs: number;
	};
	mediaUnderstanding: {
		audio: {
			provider: MediaUnderstandingProvider;
			model: string;
			apiKeyEnv: string;
		};
		video: {
			provider: MediaUnderstandingProvider;
			model: string;
			baseUrl?: string;
			apiKeyEnv: string;
		};
	};
	persona: {
		soul: string;
		user: string;
		contact: string;
		memory: string;
		inner: string;
	};
	media: {
		generatedRetentionDays: number;
	};
	data: {
		chat: {
			retentionDays: number;
		};
		transcripts: {
			retentionDays: number;
		};
		payloads: {
			retentionDays: number;
		};
	};
	workspace: {
		dataDir: string;
	};
	memory: {
		rootDir: string;
		indexDir: string;
		lcmDir: string;
		diariesDir: string;
		archiveDir: string;
		embedding: {
			format?: MemoryEmbeddingFormat;
			api: MemoryEmbeddingFormat;
			provider: string;
			model: string;
			baseUrl: string;
			apiKeyEnv: string;
			dimensions: number;
			batchSize: number;
		};
		ambient: {
			enabled: boolean;
			topK: number;
			minQueryLength: number;
			throttleSeconds: number;
			weightSimilarity: number;
			weightValence: number;
			weightRecency: number;
			weightIntensity: number;
		};
		lcm: {
			enabled: boolean;
			model: string;
			provider: string;
			modelId: string;
			baseUrl?: string;
			apiKeyEnv?: string;
			contextThreshold: number;
			freshTailCount: number;
			freshTailMaxTokens?: number;
			leafChunkTokens: number;
			leafTargetTokens: number;
			promptAwareEvictionEnabled: boolean;
			condenseGroupSize: number;
			maxSummaryDepth: number;
			newSessionRetainDepth: number;
			maxRounds: number;
			cacheTtlMs: number;
			cacheTouchSlackMs: number;
			criticalOverflowTokens: number;
			timeoutMs: number;
			prompt?: string;
			promptPath?: string;
			systemPrompt?: string;
			systemPromptPath?: string;
		};
	};
}
