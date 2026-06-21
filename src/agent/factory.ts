import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { type ImageContent, type Model, streamSimple } from "@earendil-works/pi-ai";
import type { Config, ThinkingLevel } from "../config/index.js";
import { setConfigOverridesPath } from "../config/overrides.js";
import { applyConfigOverridesToConfig } from "../config/registry.js";
import type { EffectiveSetting, SettingsStore } from "../config/settings.js";
import type { StoredAttachment } from "../conversation/chat-log.js";
import { createGeneratedMediaSink } from "../media/generated-media.js";
import type { MemoryService } from "../memory/service.js";
import { setAddedModelsPath } from "../models/added-models.js";
import {
	clampConfiguredThinkingLevel,
	createConfiguredModel,
	isThinkingLevel,
	parseModelRef,
	resolveModel,
	supportedThinkingLevels,
} from "../models/index.js";
import { buildSystemPrompt, loadPersona } from "../prompting/persona.js";
import { formatFamiliarSkillsForPrompt, loadFamiliarSkills, logSkillDiagnostics } from "../prompting/skills.js";
import { normalizeProviderPayload } from "./payload-normalizers.js";
import {
	assertModelAllowed,
	buildAnthropicMetadata,
	deriveSessionId,
	formatModel,
	getLastAssistantText,
	getRequestApiKey,
	installProviderDebugFilter,
	isNoisyProviderDebug,
	logUsage,
	resolveModelName,
	userTextMessage,
} from "./session-helpers.js";
import { normalizeToolNameStream } from "./tool-name-compat.js";
import { createFamiliarTools, setReferenceAttachments } from "./tools.js";
import { loadStoredMessages, writePayloadLog, writeTranscriptLog } from "./transcript-log.js";
import type {
	FamiliarAgent,
	FamiliarAgentOptions,
	FamiliarAgentReply,
	FamiliarAgentSession,
	FamiliarPromptOptions,
	ReloadedSession,
	ReloadSnapshot,
} from "./types.js";

export type { FamiliarAgent, FamiliarAgentOptions, FamiliarAgentReply, FamiliarPromptOptions } from "./types.js";

export const __agentTest = {
	isNoisyProviderDebug,
	normalizeProviderPayload,
};

const PROVIDER_MAX_RETRIES = 2;
const PROVIDER_MAX_RETRY_DELAY_MS = 60_000;

export async function createFamiliarAgent(
	config: Config,
	settings: SettingsStore,
	memoryService?: MemoryService,
	options: FamiliarAgentOptions = {},
): Promise<FamiliarAgent> {
	installProviderDebugFilter();
	setAddedModelsPath(config.workspace.dataDir);
	setConfigOverridesPath(config.workspace.dataDir);
	applyConfigOverridesToConfig(config);
	let persona = await loadPersona(config);
	let skillsResult = loadFamiliarSkills(config);
	logSkillDiagnostics(skillsResult);
	let systemPrompt = buildSystemPrompt(persona, formatFamiliarSkillsForPrompt(skillsResult.skills));
	console.log("---SYSTEM PROMPT (start)---");
	console.log(systemPrompt);
	console.log("---SYSTEM PROMPT (end)---");
	let defaultModel = createConfiguredModel(config);
	// Fail fast during startup if the configured default model cannot authenticate.
	getRequestApiKey(config, defaultModel);
	const sessions = new Map<string, Promise<FamiliarAgentSession>>();
	// activePromptOptions covers the synchronous promptMessage window; skipAmbientMessages
	// tags message identities so followUpMessage's fire-and-forget path also opts out.
	const activePromptOptions = new Map<string, FamiliarPromptOptions>();
	const skipAmbientMessages = new WeakSet<AgentMessage & object>();
	let reloadInProgress: Promise<void> | undefined;

	const resolveChannelModel = (sessionKey: string): { model: Model<any>; source: "config" | "override" } => {
		const override = settings.getChannelModel(sessionKey);
		const modelName = resolveModelName(override.value, defaultModel);
		const ref = parseModelRef(modelName);
		if (!ref) throw new Error(`Invalid persisted model for ${sessionKey}: ${modelName}`);
		if (override.value) assertModelAllowed(config, ref);
		const model = override.value ? resolveModel(ref, config) : defaultModel;
		getRequestApiKey(config, model);
		return { model, source: override.source };
	};

	const resolveChannelThinkingLevel = (sessionKey: string, model: Model<any>): EffectiveSetting<ThinkingLevel> => {
		const setting = settings.getChannelThinkingLevel(sessionKey, config.agent.thinkingLevel);
		return {
			value: clampConfiguredThinkingLevel(model, setting.value),
			source: setting.source,
		};
	};

	const resolveChannelModelForConfig = (
		nextConfig: Config,
		nextDefaultModel: Model<any>,
		sessionKey: string,
	): { model: Model<any>; source: "config" | "override" } => {
		const override = settings.getChannelModel(sessionKey);
		const modelName = resolveModelName(override.value, nextDefaultModel);
		const ref = parseModelRef(modelName);
		if (!ref) throw new Error(`Invalid persisted model for ${sessionKey}: ${modelName}`);
		if (override.value) assertModelAllowed(nextConfig, ref);
		const model = override.value ? resolveModel(ref, nextConfig) : nextDefaultModel;
		getRequestApiKey(nextConfig, model);
		return { model, source: override.source };
	};

	const resolveChannelThinkingLevelForConfig = (
		nextConfig: Config,
		sessionKey: string,
		model: Model<any>,
	): EffectiveSetting<ThinkingLevel> => {
		const setting = settings.getChannelThinkingLevel(sessionKey, nextConfig.agent.thinkingLevel);
		return {
			value: clampConfiguredThinkingLevel(model, setting.value),
			source: setting.source,
		};
	};

	const createSession = async (sessionKey: string): Promise<FamiliarAgentSession> => {
		const sessionId = deriveSessionId(config.workspacePath, sessionKey);
		const messages = await loadStoredMessages(config.workspace.dataDir, sessionId);
		const { model } = resolveChannelModel(sessionKey);
		const thinkingLevel = resolveChannelThinkingLevel(sessionKey, model).value;
		const mediaSink = createGeneratedMediaSink();
		const referenceAttachments: StoredAttachment[] = [];
		console.log(`Loaded ${messages.length} prior messages from session history for ${sessionKey}`);
		let agent!: Agent;
		agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				messages,
				tools: createFamiliarTools(config, mediaSink, () => referenceAttachments, memoryService),
				thinkingLevel,
			},
			sessionId,
			streamFn: (streamModel, context, options) => {
				const stream = streamSimple(streamModel, context, {
					...options,
					apiKey: getRequestApiKey(config, streamModel),
					metadata: buildAnthropicMetadata(config, streamModel),
					cacheRetention: config.agent.cacheRetention,
					maxRetries: options?.maxRetries ?? PROVIDER_MAX_RETRIES,
					maxRetryDelayMs: options?.maxRetryDelayMs ?? PROVIDER_MAX_RETRY_DELAY_MS,
					onPayload: (payload, payloadModel) => {
						const requestPayload = normalizeProviderPayload(payload, payloadModel);
						writePayloadLog(config, {
							ts: new Date().toISOString(),
							direction: "request",
							sessionId,
							sessionKey,
							model: payloadModel.id,
							payload: requestPayload,
						});
						return requestPayload;
					},
					onResponse: (response, responseModel) => {
						writePayloadLog(config, {
							ts: new Date().toISOString(),
							direction: "response_meta",
							sessionId,
							sessionKey,
							model: responseModel.id,
							status: response.status,
							headers: response.headers,
						});
					},
				});
				return normalizeToolNameStream(stream, context.tools ?? []);
			},
			transformContext: memoryService
				? (contextMessages, signal) => {
						const activeOptions = activePromptOptions.get(sessionKey);
						const skipAmbient = activeOptions?.skipAmbient || lastUserMessageSkipsAmbient(contextMessages);
						return memoryService.transformContext(contextMessages, signal, {
							sessionKey,
							sessionId,
							model: agent.state.model,
							...(skipAmbient ? { skipAmbient: true } : {}),
						});
					}
				: undefined,
		});
		agent.subscribe((event) => {
			logUsage(event);
			if (event.type === "message_end") {
				writeTranscriptLog(config, {
					ts: new Date().toISOString(),
					sessionId,
					sessionKey,
					message: event.message,
				});
			}
		});

		return {
			agent,
			sessionId,
			model,
			thinkingLevel,
			mediaSink,
			referenceAttachments,
			promptQueue: Promise.resolve(),
		};
	};

	const getSession = async (sessionKey: string): Promise<FamiliarAgentSession> => {
		while (reloadInProgress) await reloadInProgress;
		const existing = sessions.get(sessionKey);
		if (existing) return existing;
		const sessionPromise = createSession(sessionKey);
		sessions.set(sessionKey, sessionPromise);
		try {
			return await sessionPromise;
		} catch (error) {
			sessions.delete(sessionKey);
			throw error;
		}
	};

	const resetSession = (session: FamiliarAgentSession): void => {
		session.agent.abort();
		session.agent.reset();
		writeTranscriptLog(config, {
			ts: new Date().toISOString(),
			sessionId: session.sessionId,
			type: "reset",
		});
		session.agent.state.systemPrompt = systemPrompt;
		session.agent.state.model = session.model;
		session.mediaSink.drain();
		setReferenceAttachments(session);
		session.agent.state.tools = createFamiliarTools(
			config,
			session.mediaSink,
			() => session.referenceAttachments,
			memoryService,
		);
		session.agent.state.thinkingLevel = session.thinkingLevel;
	};

	const prepareReload = async (): Promise<ReloadSnapshot> => {
		const nextConfig = (await options.reloadConfig?.()) ?? config;
		setAddedModelsPath(nextConfig.workspace.dataDir);
		setConfigOverridesPath(nextConfig.workspace.dataDir);
		applyConfigOverridesToConfig(nextConfig);
		const nextPersona = await loadPersona(nextConfig);
		const nextSkillsResult = loadFamiliarSkills(nextConfig);
		const nextSystemPrompt = buildSystemPrompt(nextPersona, formatFamiliarSkillsForPrompt(nextSkillsResult.skills));
		const nextDefaultModel = createConfiguredModel(nextConfig);
		getRequestApiKey(nextConfig, nextDefaultModel);
		return {
			config: nextConfig,
			persona: nextPersona,
			skillsResult: nextSkillsResult,
			systemPrompt: nextSystemPrompt,
			defaultModel: nextDefaultModel,
		};
	};

	const prepareReloadedSessions = async (next: ReloadSnapshot): Promise<ReloadedSession[]> => {
		return Promise.all(
			[...sessions.entries()].map(async ([sessionKey, sessionPromise]) => {
				const session = await sessionPromise;
				const { model } = resolveChannelModelForConfig(next.config, next.defaultModel, sessionKey);
				const thinkingLevel = resolveChannelThinkingLevelForConfig(next.config, sessionKey, model).value;
				return {
					session,
					model,
					thinkingLevel,
					tools: createFamiliarTools(
						next.config,
						session.mediaSink,
						() => session.referenceAttachments,
						memoryService,
					),
				};
			}),
		);
	};

	// Shared serialization wrapper for prompt/promptMessage: run after the prior turn
	// settles on the session's promptQueue, keep the stored tail non-rejecting, and run
	// teardown (onTurnEnd → reference reset → enterTurn's exit → unsubscribe) in a fixed
	// order regardless of how the turn ends. enterTurn returns its own cleanup so callers
	// can scope per-turn state (e.g. activePromptOptions) across the exact finally window.
	const runPromptTurn = async (
		sessionKey: string,
		options: FamiliarPromptOptions,
		eventHandler: ((event: AgentEvent) => void | Promise<void>) | undefined,
		dispatch: (session: FamiliarAgentSession) => Promise<unknown>,
		enterTurn?: () => () => void,
	): Promise<FamiliarAgentReply> => {
		const session = await getSession(sessionKey);
		const run = session.promptQueue.then(async () => {
			session.mediaSink.drain();
			setReferenceAttachments(session, options.referenceAttachments);
			const unsubscribe = eventHandler ? session.agent.subscribe((event) => eventHandler(event)) : undefined;
			const exitTurn = enterTurn?.();
			try {
				await dispatch(session);
			} finally {
				try {
					await options.onTurnEnd?.();
				} catch (error) {
					console.error("turn end callback failed", error);
				} finally {
					setReferenceAttachments(session);
					exitTurn?.();
					unsubscribe?.();
				}
			}
			return {
				text: getLastAssistantText(session.agent),
				attachments: session.mediaSink.drain(),
			};
		});
		session.promptQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	const popLastAssistant = (session: FamiliarAgentSession, action: "retry" | "delete"): void => {
		const messages = session.agent.state.messages;
		const message = messages.at(-1);
		if (!message || message.role !== "assistant") {
			throw new Error(`No assistant message to ${action}`);
		}
		if (action === "retry" && message.stopReason === "aborted") {
			throw new Error("Cannot retry an aborted assistant message");
		}
		session.agent.state.messages = messages.slice(0, -1);
		writeTranscriptLog(config, {
			ts: new Date().toISOString(),
			sessionId: session.sessionId,
			type: "supersede",
			messageTimestamp: message.timestamp,
		});
	};

	return {
		async abort(sessionKey: string): Promise<void> {
			const session = sessions.get(sessionKey);
			if (!session) return;
			try {
				const resolved = await session;
				resolved.agent.abort();
				resolved.agent.clearAllQueues();
				await resolved.agent.waitForIdle();
			} catch (error) {
				console.error(`failed to abort familiar session ${sessionKey}`, error);
			}
		},
		async retryLastAssistant(
			sessionKey: string,
			eventHandler?: (event: AgentEvent) => void | Promise<void>,
			options: FamiliarPromptOptions = {},
		): Promise<FamiliarAgentReply> {
			return runPromptTurn(sessionKey, options, eventHandler, async (session) => {
				popLastAssistant(session, "retry");
				await session.agent.continue();
			});
		},
		async deleteLastAssistant(sessionKey: string): Promise<void> {
			const session = await getSession(sessionKey);
			await session.promptQueue;
			popLastAssistant(session, "delete");
		},
		async reset(sessionKey: string): Promise<void> {
			const existing = sessions.get(sessionKey);
			if (!existing) return;
			const session = await existing;
			resetSession(session);
		},
		async reload(): Promise<string> {
			while (reloadInProgress) await reloadInProgress;
			let releaseReload: (() => void) | undefined;
			reloadInProgress = new Promise<void>((resolveReload) => {
				releaseReload = resolveReload;
			});
			try {
				const previousModel = formatModel(defaultModel);
				const next = await prepareReload();
				const reloadedSessions = await prepareReloadedSessions(next);
				Object.assign(config, next.config);
				setAddedModelsPath(config.workspace.dataDir);
				persona = next.persona;
				skillsResult = next.skillsResult;
				logSkillDiagnostics(skillsResult);
				systemPrompt = next.systemPrompt;
				defaultModel = next.defaultModel;
				for (const nextSession of reloadedSessions) {
					nextSession.session.model = nextSession.model;
					nextSession.session.thinkingLevel = nextSession.thinkingLevel;
					nextSession.session.agent.state.systemPrompt = systemPrompt;
					nextSession.session.agent.state.model = nextSession.model;
					nextSession.session.agent.state.thinkingLevel = nextSession.thinkingLevel;
					nextSession.session.agent.state.tools = nextSession.tools;
				}
				const modelLine =
					previousModel === formatModel(defaultModel)
						? `default_model: ${previousModel}`
						: `default_model: ${previousModel} -> ${formatModel(defaultModel)}`;
				return [
					"Reloaded persona prompt, skills, and live agent settings.",
					modelLine,
					`skills: ${skillsResult.skills.length} loaded${skillsResult.diagnostics.length ? ` (${skillsResult.diagnostics.length} warnings)` : ""}`,
					`active_sessions: ${reloadedSessions.length}`,
					"restart_required_for: Discord/Web listener settings, memory database paths, and long-lived memory internals",
				].join("\n");
			} finally {
				releaseReload?.();
				reloadInProgress = undefined;
			}
		},
		resolveChannelModel,
		getModel(sessionKey: string): EffectiveSetting<string> {
			const { model, source } = resolveChannelModel(sessionKey);
			return { value: formatModel(model), source };
		},
		getThinkingLevel(sessionKey: string): EffectiveSetting<string> {
			const { model } = resolveChannelModel(sessionKey);
			const thinkingLevel = resolveChannelThinkingLevel(sessionKey, model);
			return thinkingLevel;
		},
		async setModel(sessionKey: string, input: string): Promise<string> {
			const ref = parseModelRef(input);
			if (!ref) throw new Error("Usage: /model provider/model-id");
			assertModelAllowed(config, ref);
			const nextModel = resolveModel(ref, config);
			getRequestApiKey(config, nextModel);
			const previousThinking = settings.getChannelThinkingLevel(sessionKey, config.agent.thinkingLevel).value;
			const nextThinking = clampConfiguredThinkingLevel(nextModel, previousThinking);
			await settings.setChannelModel(sessionKey, formatModel(nextModel));
			const sessionPromise = sessions.get(sessionKey);
			if (sessionPromise) {
				const session = await sessionPromise;
				session.model = nextModel;
				session.thinkingLevel = nextThinking;
				session.agent.state.model = nextModel;
				session.agent.state.thinkingLevel = nextThinking;
			}
			const suffix = nextThinking === previousThinking ? "" : ` (clamped from ${previousThinking})`;
			return `Model set to ${formatModel(nextModel)} for this channel\nThinking: ${nextThinking}${suffix}`;
		},
		async setThinkingLevel(sessionKey: string, input: string): Promise<string> {
			const level = input.trim().toLowerCase();
			if (!isThinkingLevel(level)) {
				throw new Error("Usage: /thinking off|minimal|low|medium|high|xhigh");
			}
			const { model } = resolveChannelModel(sessionKey);
			const clamped = clampConfiguredThinkingLevel(model, level);
			await settings.setChannelThinkingLevel(sessionKey, clamped);
			const sessionPromise = sessions.get(sessionKey);
			if (sessionPromise) {
				const session = await sessionPromise;
				session.thinkingLevel = clamped;
				session.agent.state.thinkingLevel = clamped;
			}
			const suffix = clamped === level ? "" : ` (clamped from ${level})`;
			return `Thinking set to ${clamped}${suffix} for this channel\nSupported: ${supportedThinkingLevels(model).join(", ")}`;
		},
		async prompt(
			sessionKey: string,
			input: string,
			imagesOrOnEvent?: ImageContent[] | ((event: AgentEvent) => void | Promise<void>),
			onEvent?: (event: AgentEvent) => void | Promise<void>,
			options: FamiliarPromptOptions = {},
		): Promise<FamiliarAgentReply> {
			const images = Array.isArray(imagesOrOnEvent) ? imagesOrOnEvent : undefined;
			const eventHandler = Array.isArray(imagesOrOnEvent) ? onEvent : imagesOrOnEvent;
			return runPromptTurn(sessionKey, options, eventHandler, (session) => session.agent.prompt(input, images));
		},
		async promptMessage(
			sessionKey: string,
			message: AgentMessage,
			onEvent?: (event: AgentEvent) => void | Promise<void>,
			options: FamiliarPromptOptions = {},
		): Promise<FamiliarAgentReply> {
			return runPromptTurn(
				sessionKey,
				options,
				onEvent,
				(session) => session.agent.prompt(message),
				() => {
					const previousOptions = activePromptOptions.get(sessionKey);
					activePromptOptions.set(sessionKey, options);
					if (options.skipAmbient) skipAmbientMessages.add(message);
					return () => {
						if (previousOptions) activePromptOptions.set(sessionKey, previousOptions);
						else activePromptOptions.delete(sessionKey);
					};
				},
			);
		},
		steer(sessionKey: string, input: string): void {
			const session = sessions.get(sessionKey);
			if (!session) return;
			void session
				.then((resolved) => {
					resolved.agent.steer(userTextMessage(input));
				})
				.catch((error) => console.error(`failed to load familiar session ${sessionKey} for steer`, error));
		},
		steerMessage(sessionKey: string, message: AgentMessage): void {
			const session = sessions.get(sessionKey);
			if (!session) return;
			void session
				.then((resolved) => {
					resolved.agent.steer(message);
				})
				.catch((error) => console.error(`failed to load familiar session ${sessionKey} for steer`, error));
		},
		async followUpMessage(
			sessionKey: string,
			message: AgentMessage,
			options: FamiliarPromptOptions = {},
		): Promise<void> {
			const session = await getSession(sessionKey);
			if (options.skipAmbient) skipAmbientMessages.add(message);
			session.agent.followUp(message);
		},
	};

	function lastUserMessageSkipsAmbient(messages: readonly AgentMessage[]): boolean {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (!message || typeof message !== "object" || !("role" in message)) continue;
			if (message.role !== "user") continue;
			return skipAmbientMessages.has(message);
		}
		return false;
	}
}
