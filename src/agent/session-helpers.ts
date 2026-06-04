import { createHash } from "node:crypto";

import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Config } from "../config/index.js";
import { assertModelCanAuthenticate, isAllowedModel, type ModelRef, resolveModelApiKey } from "../models/index.js";

const NOISY_GOOGLE_VERTEX_AUTH_DEBUG =
	"The user provided project/location will take precedence over the API key from the environment variables.";

let providerDebugFilterInstalled = false;

export function deriveSessionId(workspacePath: string, sessionKey: string): string {
	const digest = createHash("sha256").update(`${workspacePath}\0${sessionKey}`).digest("hex").slice(0, 32);
	return `familiar-${digest}`;
}

export function isNoisyProviderDebug(args: unknown[]): boolean {
	return args.length === 1 && args[0] === NOISY_GOOGLE_VERTEX_AUTH_DEBUG;
}

export function installProviderDebugFilter(): void {
	if (providerDebugFilterInstalled) return;
	providerDebugFilterInstalled = true;
	const debug = console.debug;
	console.debug = (...args: unknown[]) => {
		if (isNoisyProviderDebug(args)) return;
		debug.apply(console, args);
	};
}

export function getRequestApiKey(config: Config, model: Model<any>): string | undefined {
	const apiKey = resolveModelApiKey(config, model);
	assertModelCanAuthenticate(config, model);
	return apiKey;
}

export function formatModel(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

export function resolveModelName(value: string | undefined, fallback: Model<any>): string {
	return value ?? formatModel(fallback);
}

export function assertModelAllowed(config: Config, ref: ModelRef): void {
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

export function getLastAssistantText(agent: Agent): string {
	for (let i = agent.state.messages.length - 1; i >= 0; i--) {
		const message = agent.state.messages[i];
		if (message.role === "assistant") return extractText(message);
	}
	return "";
}

export function logUsage(event: AgentEvent): void {
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

export function userTextMessage(text: string, timestamp = Date.now()): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp,
	};
}
