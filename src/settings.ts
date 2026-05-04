import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { Config, DiscordChannelTrigger, ThinkingLevel } from "./config.js";

export type SettingSource = "config" | "override";

export interface EffectiveSetting<T> {
	value: T;
	source: SettingSource;
}

export interface ChannelSettings {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	channelTrigger?: DiscordChannelTrigger;
}

export interface SettingsStore {
	path: string;
	getChannelSettings(channelKey: string): ChannelSettings;
	getChannelModel(channelKey: string): EffectiveSetting<string | undefined>;
	getChannelThinkingLevel(channelKey: string, fallback: ThinkingLevel): EffectiveSetting<ThinkingLevel>;
	getChannelTrigger(channelKey: string, fallback: DiscordChannelTrigger): EffectiveSetting<DiscordChannelTrigger>;
	setChannelModel(channelKey: string, model: string): Promise<void>;
	setChannelThinkingLevel(channelKey: string, thinkingLevel: ThinkingLevel): Promise<void>;
	setChannelTrigger(channelKey: string, channelTrigger: DiscordChannelTrigger): Promise<void>;
}

interface SettingsFile {
	version: 1;
	channels: Record<string, ChannelSettings>;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	);
}

function isChannelTrigger(value: unknown): value is DiscordChannelTrigger {
	return value === "mention" || value === "always";
}

function normalizeChannelSettings(value: unknown): ChannelSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const input = value as Record<string, unknown>;
	return {
		model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined,
		thinkingLevel: isThinkingLevel(input.thinkingLevel) ? input.thinkingLevel : undefined,
		channelTrigger: isChannelTrigger(input.channelTrigger) ? input.channelTrigger : undefined,
	};
}

function normalizeSettingsFile(value: unknown): SettingsFile {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { version: 1, channels: {} };
	const input = value as Record<string, unknown>;
	const channelsInput =
		input.channels && typeof input.channels === "object" && !Array.isArray(input.channels)
			? (input.channels as Record<string, unknown>)
			: {};
	const channels: Record<string, ChannelSettings> = {};
	for (const [channelKey, settings] of Object.entries(channelsInput)) {
		const normalized = normalizeChannelSettings(settings);
		if (normalized.model || normalized.thinkingLevel || normalized.channelTrigger) channels[channelKey] = normalized;
	}
	return { version: 1, channels };
}

async function readSettingsFile(path: string): Promise<SettingsFile> {
	try {
		const raw = await readFile(path, "utf8");
		return normalizeSettingsFile(JSON.parse(raw) as unknown);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { version: 1, channels: {} };
		}
		throw error;
	}
}

function pruneChannel(settings: ChannelSettings): ChannelSettings | undefined {
	const pruned: ChannelSettings = {};
	if (settings.model) pruned.model = settings.model;
	if (settings.thinkingLevel) pruned.thinkingLevel = settings.thinkingLevel;
	if (settings.channelTrigger) pruned.channelTrigger = settings.channelTrigger;
	return pruned.model || pruned.thinkingLevel || pruned.channelTrigger ? pruned : undefined;
}

export async function loadSettingsStore(config: Config): Promise<SettingsStore> {
	const path = resolve(config.workspace.dataDir, "settings", "channel-overrides.json");
	let file = await readSettingsFile(path);
	let writeQueue = Promise.resolve();

	const persist = async (): Promise<void> => {
		await mkdir(dirname(path), { recursive: true });
		const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
		await rename(tmpPath, path);
	};

	const enqueuePersist = (): Promise<void> => {
		const run = writeQueue.then(persist, persist);
		writeQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	const updateChannel = async (channelKey: string, patch: ChannelSettings): Promise<void> => {
		const next = pruneChannel({ ...file.channels[channelKey], ...patch });
		file = {
			version: 1,
			channels: {
				...file.channels,
				[channelKey]: next ?? {},
			},
		};
		if (!next) delete file.channels[channelKey];
		await enqueuePersist();
	};

	return {
		path,
		getChannelSettings(channelKey: string): ChannelSettings {
			return { ...file.channels[channelKey] };
		},
		getChannelModel(channelKey: string): EffectiveSetting<string | undefined> {
			const model = file.channels[channelKey]?.model;
			return model ? { value: model, source: "override" } : { value: undefined, source: "config" };
		},
		getChannelThinkingLevel(channelKey: string, fallback: ThinkingLevel): EffectiveSetting<ThinkingLevel> {
			const thinkingLevel = file.channels[channelKey]?.thinkingLevel;
			return thinkingLevel ? { value: thinkingLevel, source: "override" } : { value: fallback, source: "config" };
		},
		getChannelTrigger(channelKey: string, fallback: DiscordChannelTrigger): EffectiveSetting<DiscordChannelTrigger> {
			const channelTrigger = file.channels[channelKey]?.channelTrigger;
			return channelTrigger ? { value: channelTrigger, source: "override" } : { value: fallback, source: "config" };
		},
		async setChannelModel(channelKey: string, model: string): Promise<void> {
			await updateChannel(channelKey, { model });
		},
		async setChannelThinkingLevel(channelKey: string, thinkingLevel: ThinkingLevel): Promise<void> {
			await updateChannel(channelKey, { thinkingLevel });
		},
		async setChannelTrigger(channelKey: string, channelTrigger: DiscordChannelTrigger): Promise<void> {
			await updateChannel(channelKey, { channelTrigger });
		},
	};
}
