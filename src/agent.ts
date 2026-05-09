import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { type ImageContent, type Model, streamSimple } from "@earendil-works/pi-ai";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";

import type { Config, ThinkingLevel } from "./config.js";
import { createGeneratedMediaSink, type GeneratedAttachment, type GeneratedMediaSink } from "./generated-media.js";
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
import { createTtsTool } from "./tts.js";
import { createWebTools, webContentWarning } from "./web-tools.js";

export interface FamiliarAgentReply {
	text: string;
	attachments: GeneratedAttachment[];
}

export interface FamiliarAgent {
	prompt(
		sessionKey: string,
		input: string,
		images?: ImageContent[],
		onEvent?: (event: AgentEvent) => void | Promise<void>,
	): Promise<FamiliarAgentReply>;
	steer(sessionKey: string, input: string): void;
	abort(sessionKey: string): void;
	reset(sessionKey: string): Promise<void>;
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
	promptQueue: Promise<void>;
}

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
	if (!nextPayload || typeof nextPayload !== "object") return nextPayload;
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

function normalizeProviderPayload(payload: unknown, model: Model<any>): unknown {
	return stripOpenAIStoredReasoningItems(payload, model);
}

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
		if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
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

function createFamiliarTools(config: Config, mediaSink: GeneratedMediaSink): AgentTool<any>[] {
	return [
		createBashTool(config.workspacePath),
		createReadTool(config.workspacePath),
		createWriteTool(config.workspacePath),
		createEditTool(config.workspacePath),
		createTtsTool(config, mediaSink),
		...createWebTools(config),
	];
}

export async function createFamiliarAgent(config: Config, settings: SettingsStore): Promise<FamiliarAgent> {
	const persona = await loadPersona(config);
	const systemPrompt = [buildSystemPrompt(persona), webContentWarning()].join("\n\n");
	console.log("---SYSTEM PROMPT (start)---");
	console.log(systemPrompt);
	console.log("---SYSTEM PROMPT (end)---");
	const defaultModel = createConfiguredModel(config);
	// Fail fast during startup if the configured default model cannot authenticate.
	getRequestApiKey(config, defaultModel);
	const sessions = new Map<string, Promise<FamiliarAgentSession>>();

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

	const createSession = async (sessionKey: string): Promise<FamiliarAgentSession> => {
		const sessionId = deriveSessionId(config.workspacePath, sessionKey);
		const messages = await loadStoredMessages(config.workspace.dataDir, sessionId);
		const { model } = resolveChannelModel(sessionKey);
		const thinkingLevel = resolveChannelThinkingLevel(sessionKey, model).value;
		const mediaSink = createGeneratedMediaSink();
		console.log(`Loaded ${messages.length} prior messages from session history for ${sessionKey}`);
		const agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				messages,
				tools: createFamiliarTools(config, mediaSink),
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
			promptQueue: Promise.resolve(),
		};
	};

	const getSession = async (sessionKey: string): Promise<FamiliarAgentSession> => {
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
		session.agent.state.tools = createFamiliarTools(config, session.mediaSink);
		session.agent.state.thinkingLevel = session.thinkingLevel;
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
		async reset(sessionKey: string): Promise<void> {
			const existing = sessions.get(sessionKey);
			if (!existing) return;
			const session = await existing;
			resetSession(session);
		},
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
		): Promise<FamiliarAgentReply> {
			const session = await getSession(sessionKey);
			const images = Array.isArray(imagesOrOnEvent) ? imagesOrOnEvent : undefined;
			const eventHandler = Array.isArray(imagesOrOnEvent) ? onEvent : imagesOrOnEvent;
			const run = session.promptQueue.then(async () => {
				session.mediaSink.drain();
				const unsubscribe = eventHandler ? session.agent.subscribe((event) => eventHandler(event)) : undefined;
				try {
					await session.agent.prompt(input, images);
				} finally {
					unsubscribe?.();
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
					resolved.agent.steer({
						role: "user",
						content: [{ type: "text", text: input }],
						timestamp: Date.now(),
					});
				})
				.catch((error) => console.error(`failed to load familiar session ${sessionKey} for steer`, error));
		},
	};
}
