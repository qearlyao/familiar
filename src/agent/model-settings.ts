import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS } from "../config/enums.js";
import type { Config, ThinkingLevel } from "../config/index.js";
import type { EffectiveSetting, SettingsStore } from "../config/settings.js";
import {
	clampConfiguredThinkingLevel,
	isThinkingLevel,
	parseModelRef,
	resolveModel,
	supportedThinkingLevels,
} from "../models/index.js";
import { assertModelCanAuthenticateWithRuntime } from "../models/runtime.js";
import { assertModelAllowed, formatModel, resolveModelName } from "./session-helpers.js";

/** each session's model and thinking level: a stored per-channel override, else the configured default */
export function createModelSettings(settings: SettingsStore, modelRuntime: ModelRuntime) {
	// a session that borrows another's model and thinking (a voice call takes its chat's)
	const sources = new Map<string, string>();
	const settingsKey = (sessionKey: string): string => sources.get(sessionKey) ?? sessionKey;

	const resolveSessionModel = (
		config: Config,
		defaultModel: Model<any>,
		sessionKey: string,
	): { model: Model<any>; source: "config" | "override" } => {
		const override = settings.getChannelModel(settingsKey(sessionKey));
		const modelName = resolveModelName(override.value, defaultModel);
		const ref = parseModelRef(modelName);
		if (!ref) throw new Error(`Invalid persisted model for ${sessionKey}: ${modelName}`);
		if (override.value) assertModelAllowed(config, ref);
		const model = override.value ? resolveModel(ref, config, modelRuntime) : defaultModel;
		return { model, source: override.source };
	};

	const resolveThinkingLevel = (
		config: Config,
		sessionKey: string,
		model: Model<any>,
	): EffectiveSetting<ThinkingLevel> => {
		const setting = settings.getChannelThinkingLevel(settingsKey(sessionKey), config.agent.thinkingLevel);
		return { value: clampConfiguredThinkingLevel(model, setting.value), source: setting.source };
	};

	return {
		borrow(sessionKey: string, from: string): void {
			sources.set(sessionKey, from);
		},
		forget(sessionKey: string): void {
			sources.delete(sessionKey);
		},
		resolveModel: resolveSessionModel,
		resolveThinkingLevel,

		/** validate and store a channel's model; the thinking level it carries over is clamped to the new model */
		async setModel(
			config: Config,
			sessionKey: string,
			input: string,
		): Promise<{ model: Model<any>; thinkingLevel: ThinkingLevel; message: string }> {
			const ref = parseModelRef(input);
			if (!ref) throw new Error("Usage: /model provider/model-id");
			assertModelAllowed(config, ref);
			const model = resolveModel(ref, config, modelRuntime);
			await assertModelCanAuthenticateWithRuntime(config, modelRuntime, model);
			const previous = settings.getChannelThinkingLevel(settingsKey(sessionKey), config.agent.thinkingLevel).value;
			const thinkingLevel = clampConfiguredThinkingLevel(model, previous);
			await settings.setChannelModel(sessionKey, formatModel(model));
			const suffix = thinkingLevel === previous ? "" : ` (clamped from ${previous})`;
			return {
				model,
				thinkingLevel,
				message: `Model set to ${formatModel(model)} for this channel\nThinking: ${thinkingLevel}${suffix}`,
			};
		},

		/** validate and store a channel's thinking level, clamped to what its model supports */
		async setThinkingLevel(
			model: Model<any>,
			sessionKey: string,
			input: string,
		): Promise<{ thinkingLevel: ThinkingLevel; message: string }> {
			const level = input.trim().toLowerCase();
			if (!isThinkingLevel(level)) {
				throw new Error(`Usage: /thinking ${THINKING_LEVELS.join("|")}`);
			}
			const thinkingLevel = clampConfiguredThinkingLevel(model, level);
			await settings.setChannelThinkingLevel(sessionKey, thinkingLevel);
			const suffix = thinkingLevel === level ? "" : ` (clamped from ${level})`;
			return {
				thinkingLevel,
				message: `Thinking set to ${thinkingLevel}${suffix} for this channel\nSupported: ${supportedThinkingLevels(model).join(", ")}`,
			};
		},
	};
}
