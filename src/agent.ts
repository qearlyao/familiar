import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { type Model, streamSimple } from "@mariozechner/pi-ai";
import { createBashTool, createEditTool, createReadTool } from "@mariozechner/pi-coding-agent";

import type { Config } from "./config.js";
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

export interface FamiliarAgent {
	prompt(sessionKey: string, input: string): Promise<string>;
	steer(sessionKey: string, input: string): void;
	abort(sessionKey: string): void;
	reset(sessionKey: string): Promise<void>;
	getModelName(): string;
	getThinkingLevel(): string;
	setModel(input: string): string;
	setThinkingLevel(input: string): string;
}

interface FamiliarAgentSession {
	agent: Agent;
	sessionId: string;
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

function stripCacheControl(value: unknown): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) stripCacheControl(item);
		return;
	}
	const record = value as Record<string, unknown>;
	delete record.cache_control;
	for (const child of Object.values(record)) stripCacheControl(child);
}

function findLastAnthropicUserCacheBlock(payload: unknown): Record<string, unknown> | undefined {
	if (!payload || typeof payload !== "object" || !("messages" in payload)) return undefined;
	const messages = (payload as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") continue;
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") return undefined;
		if (!Array.isArray(content)) return undefined;
		for (let j = content.length - 1; j >= 0; j--) {
			const block = content[j];
			if (block && typeof block === "object" && "cache_control" in block) return block as Record<string, unknown>;
		}
		return undefined;
	}
	return undefined;
}

function keepOnlyLatestUserCacheControl(payload: unknown, model: Model<any>): unknown {
	if (model.api !== "anthropic-messages") return payload;
	const nextPayload = clonePayload(payload);
	const cacheBlock = findLastAnthropicUserCacheBlock(nextPayload);
	const cacheControl = cacheBlock?.cache_control;
	stripCacheControl(nextPayload);
	if (cacheBlock && cacheControl !== undefined) cacheBlock.cache_control = cacheControl;
	return nextPayload;
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

export async function createFamiliarAgent(config: Config): Promise<FamiliarAgent> {
	const persona = await loadPersona(config);
	const systemPrompt = buildSystemPrompt(persona);
	console.log("---SYSTEM PROMPT (start)---");
	console.log(systemPrompt);
	console.log("---SYSTEM PROMPT (end)---");
	let currentModel = createConfiguredModel(config);
	let currentThinkingLevel = config.agent.thinkingLevel;
	// Fail fast during startup if the configured default model cannot authenticate.
	getRequestApiKey(config, currentModel);
	const sessions = new Map<string, Promise<FamiliarAgentSession>>();

	const createSession = async (sessionKey: string): Promise<FamiliarAgentSession> => {
		const sessionId = deriveSessionId(config.workspacePath, sessionKey);
		const messages = await loadStoredMessages(config.workspace.dataDir, sessionId);
		console.log(`Loaded ${messages.length} prior messages from session history for ${sessionKey}`);
		const agent = new Agent({
			initialState: {
				systemPrompt,
				model: currentModel,
				messages,
				tools: [
					createBashTool(config.workspacePath),
					createReadTool(config.workspacePath),
					createEditTool(config.workspacePath),
				],
				thinkingLevel: currentThinkingLevel,
			},
			sessionId,
			streamFn: (streamModel, context, options) =>
				streamSimple(streamModel, context, {
					...options,
					apiKey: getRequestApiKey(config, streamModel),
					cacheRetention: config.agent.cacheRetention,
					onPayload: (payload, payloadModel) => {
						const requestPayload = keepOnlyLatestUserCacheControl(payload, payloadModel);
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
		session.agent.state.model = currentModel;
		session.agent.state.tools = [
			createBashTool(config.workspacePath),
			createReadTool(config.workspacePath),
			createEditTool(config.workspacePath),
		];
		session.agent.state.thinkingLevel = currentThinkingLevel;
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
		getModelName(): string {
			return formatModel(currentModel);
		},
		getThinkingLevel(): string {
			return currentThinkingLevel;
		},
		setModel(input: string): string {
			const ref = parseModelRef(input);
			if (!ref) throw new Error("Usage: /model provider/model-id");
			assertModelAllowed(config, ref);
			const nextModel = resolveModel(ref, config);
			getRequestApiKey(config, nextModel);
			currentModel = nextModel;
			currentThinkingLevel = clampConfiguredThinkingLevel(nextModel, currentThinkingLevel);
			for (const sessionPromise of sessions.values()) {
				sessionPromise
					.then((session) => {
						session.agent.state.model = currentModel;
						session.agent.state.thinkingLevel = currentThinkingLevel;
					})
					.catch(() => undefined);
			}
			return `Model set to ${formatModel(nextModel)}\nThinking: ${currentThinkingLevel}`;
		},
		setThinkingLevel(input: string): string {
			const level = input.trim().toLowerCase();
			if (!isThinkingLevel(level)) {
				throw new Error("Usage: /thinking off|minimal|low|medium|high|xhigh");
			}
			const clamped = clampConfiguredThinkingLevel(currentModel, level);
			currentThinkingLevel = clamped;
			for (const sessionPromise of sessions.values()) {
				sessionPromise
					.then((session) => {
						session.agent.state.thinkingLevel = currentThinkingLevel;
					})
					.catch(() => undefined);
			}
			const suffix = clamped === level ? "" : ` (clamped from ${level})`;
			return `Thinking set to ${clamped}${suffix}\nSupported: ${supportedThinkingLevels(currentModel).join(", ")}`;
		},
		async prompt(sessionKey: string, input: string): Promise<string> {
			const session = await getSession(sessionKey);
			const run = session.promptQueue.then(async () => {
				await session.agent.prompt(input);
				return getLastAssistantText(session.agent);
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
