import { createHash } from "node:crypto";

import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { type Model, streamSimple } from "@mariozechner/pi-ai";
import { createBashTool, createEditTool, createReadTool } from "@mariozechner/pi-coding-agent";

import type { Config } from "./config.js";
import { buildSystemPrompt, loadPersona } from "./persona.js";

export interface FamiliarAgent {
	agent: Agent;
	sessionId: string;
	prompt(input: string): Promise<string>;
}

function deriveSessionId(workspacePath: string): string {
	const digest = createHash("sha256").update(workspacePath).digest("hex").slice(0, 32);
	return `familiar-${digest}`;
}

function createConfiguredModel(config: Config): Model<any> {
	return {
		id: config.agent.modelId,
		name: config.agent.modelId,
		api: config.agent.api,
		provider: config.agent.provider,
		baseUrl: config.agent.baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function getConfiguredApiKey(config: Config): string {
	const apiKey = process.env[config.agent.apiKeyEnv];
	if (!apiKey) {
		throw new Error(`Missing LLM API key environment variable: ${config.agent.apiKeyEnv}`);
	}
	return apiKey;
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
	const model = createConfiguredModel(config);
	const apiKey = getConfiguredApiKey(config);

	const sessionId = deriveSessionId(config.workspacePath);
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			tools: [
				createBashTool(config.workspacePath),
				createReadTool(config.workspacePath),
				createEditTool(config.workspacePath),
			],
			thinkingLevel: "off",
		},
		sessionId,
		streamFn: (streamModel, context, options) =>
			streamSimple(streamModel, context, {
				...options,
				apiKey,
				cacheRetention: config.agent.cacheRetention,
			}),
	});

	agent.subscribe((event) => {
		logUsage(event);
	});

	let promptQueue = Promise.resolve();

	return {
		agent,
		sessionId,
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
