import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { Config } from "../config/index.js";
import { setConfigOverridesPath } from "../config/overrides.js";
import { applyConfigOverridesToConfig } from "../config/registry.js";
import type { EffectiveSetting, SettingsStore } from "../config/settings.js";
import type { MemoryService } from "../memory/service.js";
import { setAddedModelsPath } from "../models/added-models.js";
import { createConfiguredModel } from "../models/index.js";
import { harnessNoteMessage, userTextMessage } from "../models/messages.js";
import { assertModelCanAuthenticateWithRuntime, createModelRuntime } from "../models/runtime.js";
import { buildSystemPrompt, loadPersona, logPromptSources } from "../prompting/persona.js";
import { formatFamiliarSkillsForPrompt, loadFamiliarSkills } from "../prompting/skills.js";
import { createMcpHub } from "../tools/mcp.js";
import { mcpServerSpecs, setMcpServersPath } from "../tools/mcp-servers.js";
import { createModelSettings } from "./model-settings.js";
import { createAgentSession, editLastAssistant, popLastAssistant, type SessionToolParts } from "./session.js";
import { deriveSessionId, formatModel, getLastAssistantText, installProviderDebugFilter } from "./session-helpers.js";
import { createSessionMemory } from "./session-memory.js";
import { createFamiliarTools, deferredToolNames, setReferenceAttachments } from "./tools.js";
import { writeTranscriptReset } from "./transcript-log.js";
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

export async function createFamiliarAgent(
	config: Config,
	settings: SettingsStore,
	memoryService: MemoryService,
	options: FamiliarAgentOptions = {},
): Promise<FamiliarAgent> {
	installProviderDebugFilter();
	setAddedModelsPath(config.workspace.dataDir);
	setConfigOverridesPath(config.workspace.dataDir);
	applyConfigOverridesToConfig(config);
	const modelRuntime = options.modelRuntime ?? (await createModelRuntime(config));
	let persona = await loadPersona(config);
	let skillsResult = loadFamiliarSkills(config);
	logPromptSources(persona, skillsResult);
	let systemPrompt = buildSystemPrompt(
		persona,
		config.memory.diariesDir,
		formatFamiliarSkillsForPrompt(skillsResult.skills),
	);
	setMcpServersPath(config.workspace.dataDir);
	const mcp = createMcpHub(() => rebuildSessionTools());
	let defaultModel = createConfiguredModel(config, modelRuntime);
	await assertModelCanAuthenticateWithRuntime(config, modelRuntime, defaultModel);
	const sessions = new Map<string, Promise<FamiliarAgentSession>>();
	const sessionMemory = createSessionMemory(memoryService);
	const modelSettings = createModelSettings(settings, modelRuntime);
	// built-ins set aside until the next restart; never written anywhere
	const pausedTools = new Set<string>();
	const buildTools = (cfg: Config, parts: SessionToolParts) =>
		createFamiliarTools({
			config: cfg,
			mediaSink: parts.mediaSink,
			referenceAttachments: () => parts.referenceAttachments,
			memory: memoryService,
			mcp,
			agent: parts.agent,
			paused: pausedTools,
		});
	const toolsFor = (cfg: Config, session: FamiliarAgentSession) =>
		buildTools(cfg, {
			mediaSink: session.mediaSink,
			referenceAttachments: session.referenceAttachments,
			agent: () => session.agent,
		});
	// a server connecting, dropping or flipping deferred changes every live session's tool list
	const rebuildSessionTools = async (): Promise<void> => {
		for (const sessionPromise of sessions.values()) {
			const session = await sessionPromise;
			session.agent.state.tools = toolsFor(config, session);
		}
	};
	await mcp.sync(mcpServerSpecs(config));
	let reloadInProgress: Promise<void> | undefined;

	const resolveChannelModel = (sessionKey: string) => modelSettings.resolveModel(config, defaultModel, sessionKey);

	const createSession = async (sessionKey: string): Promise<FamiliarAgentSession> => {
		const { model } = resolveChannelModel(sessionKey);
		await assertModelCanAuthenticateWithRuntime(config, modelRuntime, model);
		return createAgentSession({
			config,
			modelRuntime,
			memory: sessionMemory,
			sessionKey,
			sessionId: deriveSessionId(config.workspacePath, sessionKey),
			systemPrompt,
			model,
			thinkingLevel: modelSettings.resolveThinkingLevel(config, sessionKey, model).value,
			tools: (parts) => buildTools(config, parts),
			deferredToolNames: () => deferredToolNames(config, mcp, pausedTools),
		});
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

	const resetSession = async (session: FamiliarAgentSession): Promise<void> => {
		session.agent.abort();
		session.agent.reset();
		await writeTranscriptReset(config, session.sessionId);
		session.agent.state.model = session.model;
		session.mediaSink.drain();
		setReferenceAttachments(session);
		session.agent.state.tools = toolsFor(config, session);
		const head = createInitialSystemMessage(systemPrompt, session.agent.state.tools.map(toToolDeclaration));
		session.agent.state.messages = head ? [head] : [];
		session.agent.state.thinkingLevel = session.thinkingLevel;
	};

	const prepareReload = async (): Promise<ReloadSnapshot> => {
		const nextConfig = (await options.reloadConfig?.()) ?? config;
		setAddedModelsPath(nextConfig.workspace.dataDir);
		setConfigOverridesPath(nextConfig.workspace.dataDir);
		applyConfigOverridesToConfig(nextConfig);
		const nextPersona = await loadPersona(nextConfig);
		const nextSkillsResult = loadFamiliarSkills(nextConfig);
		const nextSystemPrompt = buildSystemPrompt(
			nextPersona,
			nextConfig.memory.diariesDir,
			formatFamiliarSkillsForPrompt(nextSkillsResult.skills),
		);
		const nextDefaultModel = createConfiguredModel(nextConfig, modelRuntime);
		await assertModelCanAuthenticateWithRuntime(nextConfig, modelRuntime, nextDefaultModel);
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
				const { model } = modelSettings.resolveModel(next.config, next.defaultModel, sessionKey);
				await assertModelCanAuthenticateWithRuntime(next.config, modelRuntime, model);
				const thinkingLevel = modelSettings.resolveThinkingLevel(next.config, sessionKey, model).value;
				return {
					session,
					model,
					thinkingLevel,
					tools: toolsFor(next.config, session),
				};
			}),
		);
	};

	// Shared serialization wrapper for prompt/promptMessage: run after the prior turn
	// settles on the session's promptQueue, keep the stored tail non-rejecting, and run
	// teardown (onTurnEnd → reference reset → enterTurn's exit → unsubscribe) in a fixed
	// order regardless of how the turn ends. enterTurn returns its own cleanup so callers
	// can scope per-turn state (e.g. the turn's memory options) across the exact finally window.
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

	const abortSession = async (sessionKey: string): Promise<void> => {
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
	};

	const steerWith = (sessionKey: string, message: () => AgentMessage): void => {
		const session = sessions.get(sessionKey);
		if (!session) return;
		void session
			.then((resolved) => {
				resolved.agent.steer(message());
			})
			.catch((error) => console.error(`failed to load familiar session ${sessionKey} for steer`, error));
	};

	return {
		close: () => mcp.close(),
		mcp,
		refreshTools: rebuildSessionTools,
		pausedTools: () => pausedTools,
		async pauseTool(name, paused) {
			if (paused) pausedTools.add(name);
			else pausedTools.delete(name);
			await rebuildSessionTools();
		},
		async toolNames(sessionKey) {
			const session = await sessions.get(sessionKey);
			return session?.agent.state.tools.map((tool) => tool.name) ?? [];
		},
		getContextBreakdown: (sessionKey, tokens) => sessionMemory.contextBreakdown(sessionKey, tokens),
		abort: abortSession,
		async dispose(sessionKey: string): Promise<void> {
			await abortSession(sessionKey);
			sessions.delete(sessionKey);
			sessionMemory.forget(sessionKey);
			modelSettings.forget(sessionKey);
		},
		async retryLastAssistant(
			sessionKey: string,
			eventHandler?: (event: AgentEvent) => void | Promise<void>,
			options: FamiliarPromptOptions = {},
		): Promise<FamiliarAgentReply> {
			return runPromptTurn(sessionKey, options, eventHandler, async (session) => {
				popLastAssistant(config, session, "retry");
				await session.agent.continue();
			});
		},
		async deleteLastAssistant(sessionKey: string): Promise<void> {
			const session = await getSession(sessionKey);
			await session.promptQueue;
			popLastAssistant(config, session, "delete");
		},
		async editLastAssistant(sessionKey: string, text: string): Promise<void> {
			const session = await getSession(sessionKey);
			await session.promptQueue;
			editLastAssistant(config, session, text);
		},
		async reset(sessionKey: string): Promise<void> {
			sessionMemory.forget(sessionKey);
			const existing = sessions.get(sessionKey);
			if (!existing) return writeTranscriptReset(config, deriveSessionId(config.workspacePath, sessionKey));
			const session = await existing;
			await resetSession(session);
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
				logPromptSources(persona, skillsResult);
				systemPrompt = next.systemPrompt;
				defaultModel = next.defaultModel;
				for (const nextSession of reloadedSessions) {
					nextSession.session.model = nextSession.model;
					nextSession.session.thinkingLevel = nextSession.thinkingLevel;
					const messages = nextSession.session.agent.state.messages;
					const [head, ...rest] = messages;
					nextSession.session.agent.state.messages =
						head?.role === "system" ? [{ ...head, content: systemPrompt }, ...rest] : messages;
					nextSession.session.agent.state.model = nextSession.model;
					nextSession.session.agent.state.thinkingLevel = nextSession.thinkingLevel;
					nextSession.session.agent.state.tools = nextSession.tools;
				}
				setMcpServersPath(config.workspace.dataDir);
				await mcp.sync(mcpServerSpecs(config));
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
			return modelSettings.resolveThinkingLevel(config, sessionKey, model);
		},
		async setModel(sessionKey: string, input: string): Promise<string> {
			const { model, thinkingLevel, message } = await modelSettings.setModel(config, sessionKey, input);
			const sessionPromise = sessions.get(sessionKey);
			if (sessionPromise) {
				const session = await sessionPromise;
				session.model = model;
				session.thinkingLevel = thinkingLevel;
				session.agent.state.model = model;
				session.agent.state.thinkingLevel = thinkingLevel;
			}
			return message;
		},
		async setThinkingLevel(sessionKey: string, input: string): Promise<string> {
			const { model } = resolveChannelModel(sessionKey);
			const { thinkingLevel, message } = await modelSettings.setThinkingLevel(model, sessionKey, input);
			const sessionPromise = sessions.get(sessionKey);
			if (sessionPromise) {
				const session = await sessionPromise;
				session.thinkingLevel = thinkingLevel;
				session.agent.state.thinkingLevel = thinkingLevel;
			}
			return message;
		},
		async prompt(
			sessionKey: string,
			input: string,
			imagesOrOnEvent?: ImageContent[] | ((event: AgentEvent) => void | Promise<void>),
			onEvent?: (event: AgentEvent) => void | Promise<void>,
			options: FamiliarPromptOptions = {},
		): Promise<FamiliarAgentReply> {
			const images = Array.isArray(imagesOrOnEvent) ? imagesOrOnEvent : undefined;
			if (options.settingsFrom) modelSettings.borrow(sessionKey, options.settingsFrom);
			// the listener may ride in the images slot; a missing images slot must not drop the fourth argument
			const eventHandler = typeof imagesOrOnEvent === "function" ? imagesOrOnEvent : onEvent;
			return runPromptTurn(
				sessionKey,
				options,
				eventHandler,
				(session) => {
					const typed: AgentMessage = {
						role: "user",
						content: [{ type: "text", text: input }, ...(images ?? [])],
						timestamp: Date.now(),
					};
					return session.agent.prompt(withNotes(session, typed, options.notes));
				},
				() => sessionMemory.enterTurn(sessionKey, options),
			);
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
				(session) => {
					if (options.skipAmbient) sessionMemory.skipAmbientFor(message);
					return session.agent.prompt(withNotes(session, message, options.notes));
				},
				() => sessionMemory.enterTurn(sessionKey, options),
			);
		},
		steer(sessionKey: string, input: string): void {
			steerWith(sessionKey, () => userTextMessage(input));
		},
		steerMessage(sessionKey: string, message: AgentMessage): void {
			steerWith(sessionKey, () => message);
		},
		async followUpMessage(
			sessionKey: string,
			message: AgentMessage,
			options: FamiliarPromptOptions = {},
		): Promise<void> {
			const session = await getSession(sessionKey);
			if (options.skipAmbient) sessionMemory.skipAmbientFor(message);
			for (const queued of withNotes(session, message, options.notes)) session.agent.followUp(queued);
		},
	};

	// harness notes lead the turn in the transcript, in the harness's own voice; pi holds a note back
	// to the far side of the message it precedes, so the model hears it after. A model without
	// mid-conversation system messages would have pi drop one, so it hears the same text as user text.
	function withNotes(session: FamiliarAgentSession, message: AgentMessage, notes?: string[]): AgentMessage[] {
		if (!notes?.length) return [message];
		const timestamp = message.timestamp ?? Date.now();
		return [...notes.map((text) => harnessNoteMessage(session.agent.state.model, text, timestamp)), message];
	}
}
