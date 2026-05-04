import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { type Model, streamSimple } from "@mariozechner/pi-ai";
import { createBashTool, createEditTool, createReadTool } from "@mariozechner/pi-coding-agent";

import type { Config } from "./config.js";
import {
	clampConfiguredThinkingLevel,
	createConfiguredModel,
	describeModelAuth,
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
	agent: Agent;
	sessionId: string;
	prompt(input: string): Promise<string>;
	abort(): void;
	reset(): void;
	getModelName(): string;
	getThinkingLevel(): string;
	setModel(input: string): string;
	setThinkingLevel(input: string): string;
}

function deriveSessionId(workspacePath: string): string {
	const digest = createHash("sha256").update(workspacePath).digest("hex").slice(0, 32);
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

function getRequiredApiKey(config: Config, model: Model<any>): string {
	const apiKey = resolveModelApiKey(config, model);
	if (!apiKey) {
		throw new Error(`Missing API key for ${model.provider}/${model.id}: ${describeModelAuth(config, model)}`);
	}
	return apiKey;
}

function formatModel(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function assertModelAllowed(config: Config, ref: ModelRef): void {
	if (!isAllowedModel(config, ref)) throw new Error(`Model is not allowlisted: ${ref.key}`);
}

function extractText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content: unknown }).content;
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
	const model = createConfiguredModel(config);
	// Fail fast during startup if the configured default model cannot authenticate.
	getRequiredApiKey(config, model);

	const sessionId = deriveSessionId(config.workspacePath);
	const messages = await loadStoredMessages(config.workspace.dataDir, sessionId);
	console.log(`Loaded ${messages.length} prior messages from session history`);
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			messages,
			tools: [
				createBashTool(config.workspacePath),
				createReadTool(config.workspacePath),
				createEditTool(config.workspacePath),
			],
			thinkingLevel: config.agent.thinkingLevel,
		},
		sessionId,
		streamFn: (streamModel, context, options) =>
			streamSimple(streamModel, context, {
				...options,
				apiKey: getRequiredApiKey(config, streamModel),
				cacheRetention: config.agent.cacheRetention,
				onPayload: (payload, payloadModel) => {
					writePayloadLog(config, {
						ts: new Date().toISOString(),
						direction: "request",
						model: payloadModel.id,
						payload,
					});
					return undefined;
				},
				onResponse: (response, responseModel) => {
					writePayloadLog(config, {
						ts: new Date().toISOString(),
						direction: "response_meta",
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
				message: event.message,
			});
		}
	});

	let promptQueue = Promise.resolve();

	return {
		agent,
		sessionId,
		abort(): void {
			agent.abort();
			agent.clearAllQueues();
		},
		reset(): void {
			agent.abort();
			agent.reset();
			writeTranscriptLog(config, {
				ts: new Date().toISOString(),
				sessionId,
				type: "reset",
			});
			agent.state.systemPrompt = systemPrompt;
			agent.state.model = model;
			agent.state.tools = [
				createBashTool(config.workspacePath),
				createReadTool(config.workspacePath),
				createEditTool(config.workspacePath),
			];
			agent.state.thinkingLevel = config.agent.thinkingLevel;
		},
		getModelName(): string {
			return formatModel(agent.state.model);
		},
		getThinkingLevel(): string {
			return agent.state.thinkingLevel;
		},
		setModel(input: string): string {
			const ref = parseModelRef(input);
			if (!ref) throw new Error("Usage: /model provider/model-id");
			assertModelAllowed(config, ref);
			const nextModel = resolveModel(ref, config);
			getRequiredApiKey(config, nextModel);
			agent.state.model = nextModel;
			const nextThinking = clampConfiguredThinkingLevel(nextModel, agent.state.thinkingLevel);
			agent.state.thinkingLevel = nextThinking;
			return `Model set to ${formatModel(nextModel)}\nThinking: ${nextThinking}`;
		},
		setThinkingLevel(input: string): string {
			const level = input.trim().toLowerCase();
			if (!isThinkingLevel(level)) {
				throw new Error("Usage: /thinking off|minimal|low|medium|high|xhigh");
			}
			const clamped = clampConfiguredThinkingLevel(agent.state.model, level);
			agent.state.thinkingLevel = clamped;
			const suffix = clamped === level ? "" : ` (clamped from ${level})`;
			return `Thinking set to ${clamped}${suffix}\nSupported: ${supportedThinkingLevels(agent.state.model).join(", ")}`;
		},
		async prompt(input: string): Promise<string> {
			const run = promptQueue.then(async () => {
				await agent.prompt(input);
				return getLastAssistantText(agent);
			});
			promptQueue = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
	};
}
