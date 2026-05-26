import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { type ImageContent, type Model, streamSimple } from "@earendil-works/pi-ai";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { setAddedModelsPath } from "./added-models.js";
import { createBrowserTools } from "./browser-tools.js";
import type { StoredAttachment } from "./chat-log.js";
import type { Config, ThinkingLevel } from "./config.js";
import { setConfigOverridesPath } from "./config-overrides.js";
import { applyConfigOverridesToConfig } from "./config-registry.js";
import { createGeneratedMediaSink, type GeneratedAttachment, type GeneratedMediaSink } from "./generated-media.js";
import { createImageGenTool } from "./image-gen.js";
import type { MemoryService } from "./memory/service.js";
import {
	assertModelCanAuthenticate,
	clampConfiguredThinkingLevel,
	createConfiguredModel,
	isAllowedModel,
	isThinkingLevel,
	type ModelRef,
	parseModelRef,
	resolveModel,
	resolveModelApiKey,
	supportedThinkingLevels,
} from "./models.js";
import { buildSystemPrompt, loadPersona } from "./persona.js";
import type { EffectiveSetting, SettingsStore } from "./settings.js";
import { formatFamiliarSkillsForPrompt, loadFamiliarSkills, logSkillDiagnostics } from "./skills.js";
import { createTtsTool } from "./tts.js";
import { isEnoent } from "./util/fs.js";
import { isRecord } from "./util/guards.js";
import { createWebTools } from "./web-tools.js";

export interface FamiliarAgentReply {
	text: string;
	attachments: GeneratedAttachment[];
}

export interface FamiliarPromptOptions {
	skipAmbient?: boolean;
	referenceAttachments?: StoredAttachment[];
	onTurnEnd?: () => void | Promise<void>;
}

export interface FamiliarAgent {
	prompt(
		sessionKey: string,
		input: string,
		images?: ImageContent[],
		onEvent?: (event: AgentEvent) => void | Promise<void>,
		options?: FamiliarPromptOptions,
	): Promise<FamiliarAgentReply>;
	promptMessage(
		sessionKey: string,
		message: AgentMessage,
		onEvent?: (event: AgentEvent) => void | Promise<void>,
		options?: FamiliarPromptOptions,
	): Promise<FamiliarAgentReply>;
	steer(sessionKey: string, input: string): void;
	// Stage 9 scheduled jobs use message-shaped injections to preserve timestamps without faking user identity.
	steerMessage(sessionKey: string, message: AgentMessage): void;
	followUpMessage(sessionKey: string, message: AgentMessage, options?: FamiliarPromptOptions): Promise<void>;
	abort(sessionKey: string): void;
	requestSoftStop(sessionKey: string): void;
	reset(sessionKey: string): Promise<void>;
	reload(): Promise<string>;
	resolveChannelModel(sessionKey: string): { model: Model<any>; source: "config" | "override" };
	getModel(sessionKey: string): EffectiveSetting<string>;
	getThinkingLevel(sessionKey: string): EffectiveSetting<string>;
	setModel(sessionKey: string, input: string): Promise<string>;
	setThinkingLevel(sessionKey: string, input: string): Promise<string>;
}

interface FamiliarAgentSession {
	agent: Agent;
	sessionId: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	mediaSink: GeneratedMediaSink;
	referenceAttachments: StoredAttachment[];
	promptQueue: Promise<void>;
}

export interface FamiliarAgentOptions {
	reloadConfig?: () => Promise<Config>;
}

interface ReloadSnapshot {
	config: Config;
	persona: Awaited<ReturnType<typeof loadPersona>>;
	skillsResult: ReturnType<typeof loadFamiliarSkills>;
	systemPrompt: string;
	defaultModel: Model<any>;
}

interface ReloadedSession {
	session: FamiliarAgentSession;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool<any>[];
}

const BASH_DESCRIPTION =
	"run a bash command. defaults to the workspace; absolute paths and `~/...` reach anywhere else. returns stdout and stderr. output truncates to the last 2000 lines or 50KB, whichever hits first; full output lands in a temp file if cut. timeout in seconds optional.";

const READ_DESCRIPTION =
	"read a file. paths resolve from the workspace, but absolute paths and `~/...` work too. text and images (jpg, png, gif, webp); images come back as attachments. text output truncates to 2000 lines or 50KB, whichever hits first — use offset and limit for long files, and keep paging until you have what you need.";

const WRITE_DESCRIPTION =
	"write a file from scratch or replace it wholesale. creates the file if missing, overwrites if not, and makes parent directories as needed. paths resolve from the workspace; absolute and `~/...` also accepted.";

const EDIT_DESCRIPTION =
	"edit a file with exact text replacement. each edits[].oldText must match a unique, non-overlapping slice of the original — overlapping or nested edits are rejected, so merge nearby changes into one entry rather than chaining them. don't pad oldText with large unchanged regions just to connect distant changes. paths resolve from the workspace; absolute and `~/...` also work.";

function deriveSessionId(workspacePath: string, sessionKey: string): string {
	const digest = createHash("sha256").update(`${workspacePath}\0${sessionKey}`).digest("hex").slice(0, 32);
	return `familiar-${digest}`;
}

function dailyLogPath(dataDir: string, streamName: "payloads" | "transcripts", now = new Date()): string {
	const date = now.toISOString().slice(0, 10);
	return resolve(dataDir, streamName, `${date}.jsonl`);
}

async function appendJsonl(path: string, record: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

function writePayloadLog(config: Config, record: Record<string, unknown>): void {
	appendJsonl(dailyLogPath(config.workspace.dataDir, "payloads"), record).catch((err) =>
		console.error("payload log write failed", err),
	);
}

function writeTranscriptLog(config: Config, record: Record<string, unknown>): void {
	appendJsonl(dailyLogPath(config.workspace.dataDir, "transcripts"), record).catch((err) =>
		console.error("transcript log write failed", err),
	);
}

function clonePayload(payload: unknown): unknown {
	if (typeof structuredClone === "function") return structuredClone(payload);
	return JSON.parse(JSON.stringify(payload)) as unknown;
}

// TODO: remove once pi-ai handles store:false reasoning replay upstream.
function stripOpenAIStoredReasoningItems(payload: unknown, model: Model<any>): unknown {
	if (model.api !== "openai-responses" && model.api !== "azure-openai-responses") return payload;
	const nextPayload = clonePayload(payload);
	if (!isRecord(nextPayload)) return nextPayload;
	const request = nextPayload as { input?: unknown; store?: unknown };
	if (request.store !== false) return nextPayload;
	const input = request.input;
	if (!Array.isArray(input)) return nextPayload;
	request.input = input.filter((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return true;
		return (item as { type?: unknown }).type !== "reasoning";
	});
	return nextPayload;
}

function moveAnthropicCacheControlBeforeInjectedMemory(payload: unknown, model: Model<any>): unknown {
	if (model.api !== "anthropic-messages") return payload;
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
	const messages = payload.messages;
	const lastMessage = messages.at(-1);
	if (!isRecord(lastMessage) || lastMessage.role !== "user") return payload;
	const content = lastMessage.content;
	if (!Array.isArray(content) || content.length < 2) return payload;
	const injectedBlock = content.at(-1);
	const stableBlock = content.at(-2);
	if (!isInjectedMemoryTextBlock(injectedBlock) || !isRecord(stableBlock)) return payload;
	const cacheControl = injectedBlock.cache_control;
	if (!cacheControl) return payload;
	delete injectedBlock.cache_control;
	stableBlock.cache_control = cacheControl;
	return payload;
}

function isInjectedMemoryTextBlock(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value) || value.type !== "text" || typeof value.text !== "string") return false;
	return value.text.trim().startsWith("<injected_memory>");
}

function normalizeProviderPayload(payload: unknown, model: Model<any>): unknown {
	return moveAnthropicCacheControlBeforeInjectedMemory(stripOpenAIStoredReasoningItems(payload, model), model);
}

export const __agentTest = {
	normalizeProviderPayload,
};

type StoredMessageRecord = {
	ts: string;
	sessionId: string;
	message: AgentMessage;
};

type StoredResetRecord = {
	ts: string;
	sessionId: string;
	type: "reset";
};

type StoredTranscriptRecord = StoredMessageRecord | StoredResetRecord;

function isStoredMessageRecord(value: unknown): value is StoredMessageRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.ts === "string" && typeof record.sessionId === "string" && !!record.message;
}

function isStoredResetRecord(value: unknown): value is StoredResetRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.type === "reset" && typeof record.ts === "string" && typeof record.sessionId === "string";
}

async function loadStoredMessages(dataDir: string, sessionId: string): Promise<AgentMessage[]> {
	const transcriptsDir = resolve(dataDir, "transcripts");
	let files: string[];
	try {
		files = await readdir(transcriptsDir);
	} catch (error) {
		if (isEnoent(error)) return [];
		console.error("transcript history read failed", error);
		return [];
	}

	const records: StoredTranscriptRecord[] = [];
	for (const file of files.filter((entry) => entry.endsWith(".jsonl")).sort()) {
		const path = resolve(transcriptsDir, file);
		let contents: string;
		try {
			contents = await readFile(path, "utf8");
		} catch (error) {
			console.error(`transcript file read failed: ${path}`, error);
			continue;
		}
		for (const [index, line] of contents.split(/\r?\n/).entries()) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as unknown;
				if (!isStoredMessageRecord(parsed) && !isStoredResetRecord(parsed)) {
					console.error(`skipping malformed transcript line: ${path}:${index + 1}`);
					continue;
				}
				if (parsed.sessionId !== sessionId) continue;
				records.push(parsed);
			} catch (error) {
				console.error(`skipping unparsable transcript line: ${path}:${index + 1}`, error);
			}
		}
	}

	records.sort((a, b) => a.ts.localeCompare(b.ts));
	let lastResetIndex = -1;
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index];
		if (record && "type" in record && record.type === "reset") {
			lastResetIndex = index;
			break;
		}
	}
	const activeRecords = lastResetIndex >= 0 ? records.slice(lastResetIndex + 1) : records;
	return activeRecords.flatMap((record) => ("message" in record ? [record.message] : []));
}

function getRequestApiKey(config: Config, model: Model<any>): string | undefined {
	const apiKey = resolveModelApiKey(config, model);
	assertModelCanAuthenticate(config, model);
	return apiKey;
}

function formatModel(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function resolveModelName(value: string | undefined, fallback: Model<any>): string {
	return value ?? formatModel(fallback);
}

function assertModelAllowed(config: Config, ref: ModelRef): void {
	if (!isAllowedModel(config, ref)) throw new Error(`Model is not allowlisted: ${ref.key}`);
}

function extractText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const record = message as { content?: unknown; stopReason?: unknown; errorMessage?: unknown };
	if (record.stopReason === "error" && typeof record.errorMessage === "string" && record.errorMessage.trim()) {
		return `Model error: ${record.errorMessage}`;
	}
	if (!("content" in record)) return "";
	const content = record.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: "text"; text: string } => {
			return !!item && typeof item === "object" && (item as { type?: unknown }).type === "text";
		})
		.map((item) => item.text)
		.join("");
}

function getLastAssistantText(agent: Agent): string {
	for (let i = agent.state.messages.length - 1; i >= 0; i--) {
		const message = agent.state.messages[i];
		if (message.role === "assistant") return extractText(message);
	}
	return "";
}

function logUsage(event: AgentEvent): void {
	if (event.type !== "message_end" || event.message.role !== "assistant") return;
	const usage = event.message.usage;
	console.log(
		JSON.stringify({
			type: "usage",
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cost: usage.cost.total,
		}),
	);
}

function userTextMessage(text: string, timestamp = Date.now()): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp,
	};
}

function createFamiliarTools(
	config: Config,
	mediaSink: GeneratedMediaSink,
	referenceAttachments: () => readonly StoredAttachment[] = () => [],
	memoryService?: MemoryService,
): AgentTool<any>[] {
	const bashTool = createBashTool(config.workspacePath);
	bashTool.description = BASH_DESCRIPTION;
	const readTool = createReadTool(config.workspacePath);
	readTool.description = READ_DESCRIPTION;
	const writeTool = createWriteTool(config.workspacePath);
	writeTool.description = WRITE_DESCRIPTION;
	const editTool = createEditTool(config.workspacePath);
	editTool.description = EDIT_DESCRIPTION;
	return [
		bashTool,
		readTool,
		writeTool,
		editTool,
		createTtsTool(config, mediaSink),
		...(config.imageGen.enabled ? [createImageGenTool(config, mediaSink, { referenceAttachments })] : []),
		...createWebTools(config),
		...createBrowserTools(config, mediaSink),
		...(memoryService?.memoryTools() ?? []),
	];
}

function setReferenceAttachments(session: FamiliarAgentSession, attachments: readonly StoredAttachment[] = []): void {
	session.referenceAttachments.splice(0, session.referenceAttachments.length, ...attachments);
}

export async function createFamiliarAgent(
	config: Config,
	settings: SettingsStore,
	memoryService?: MemoryService,
	options: FamiliarAgentOptions = {},
): Promise<FamiliarAgent> {
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
	const softStopRequested = new Map<string, boolean>();
	const skipAmbientMessages = new WeakSet<AgentMessage & object>();
	let reloadInProgress: Promise<void> | undefined;

	const installSoftStopHook = (sessionKey: string, agent: Agent): void => {
		const agentWithLoopConfig = agent as unknown as {
			createLoopConfig?: (options?: { skipInitialSteeringPoll?: boolean }) => Record<string, unknown>;
		};
		const createLoopConfig = agentWithLoopConfig.createLoopConfig?.bind(agent);
		if (!createLoopConfig) return;
		agentWithLoopConfig.createLoopConfig = ((options?: { skipInitialSteeringPoll?: boolean }) => {
			return {
				...createLoopConfig(options),
				shouldStopAfterTurn: async () => softStopRequested.get(sessionKey) === true,
			};
		}) as typeof agentWithLoopConfig.createLoopConfig;
	};

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
			streamFn: (streamModel, context, options) =>
				streamSimple(streamModel, context, {
					...options,
					apiKey: getRequestApiKey(config, streamModel),
					cacheRetention: config.agent.cacheRetention,
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
				}),
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
		installSoftStopHook(sessionKey, agent);

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

	return {
		abort(sessionKey: string): void {
			const session = sessions.get(sessionKey);
			void session
				?.then((resolved) => {
					resolved.agent.abort();
					resolved.agent.clearAllQueues();
				})
				.catch((error) => console.error(`failed to abort familiar session ${sessionKey}`, error));
		},
		requestSoftStop(sessionKey: string): void {
			softStopRequested.set(sessionKey, true);
		},
		async reset(sessionKey: string): Promise<void> {
			const existing = sessions.get(sessionKey);
			if (!existing) return;
			const session = await existing;
			softStopRequested.set(sessionKey, false);
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
			const session = await getSession(sessionKey);
			const images = Array.isArray(imagesOrOnEvent) ? imagesOrOnEvent : undefined;
			const eventHandler = Array.isArray(imagesOrOnEvent) ? onEvent : imagesOrOnEvent;
			const run = session.promptQueue.then(async () => {
				softStopRequested.set(sessionKey, false);
				session.mediaSink.drain();
				setReferenceAttachments(session, options.referenceAttachments);
				const unsubscribe = eventHandler ? session.agent.subscribe((event) => eventHandler(event)) : undefined;
				try {
					await session.agent.prompt(input, images);
				} finally {
					try {
						await options.onTurnEnd?.();
					} catch (error) {
						console.error("turn end callback failed", error);
					} finally {
						setReferenceAttachments(session);
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
		},
		async promptMessage(
			sessionKey: string,
			message: AgentMessage,
			onEvent?: (event: AgentEvent) => void | Promise<void>,
			options: FamiliarPromptOptions = {},
		): Promise<FamiliarAgentReply> {
			const session = await getSession(sessionKey);
			const run = session.promptQueue.then(async () => {
				softStopRequested.set(sessionKey, false);
				session.mediaSink.drain();
				setReferenceAttachments(session, options.referenceAttachments);
				const unsubscribe = onEvent ? session.agent.subscribe((event) => onEvent(event)) : undefined;
				const previousOptions = activePromptOptions.get(sessionKey);
				activePromptOptions.set(sessionKey, options);
				if (options.skipAmbient) skipAmbientMessages.add(message);
				try {
					await session.agent.prompt(message);
				} finally {
					try {
						await options.onTurnEnd?.();
					} catch (error) {
						console.error("turn end callback failed", error);
					} finally {
						setReferenceAttachments(session);
						if (previousOptions) activePromptOptions.set(sessionKey, previousOptions);
						else activePromptOptions.delete(sessionKey);
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
