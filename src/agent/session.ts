import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Config, ThinkingLevel } from "../config/index.js";
import type { StoredAttachment } from "../conversation/chat-log.js";
import { createGeneratedMediaSink } from "../media/generated-media.js";
import { dropOrphanToolRemovals, pruneCondensedTools } from "../tools/mcp.js";
import { createProviderStreamFn } from "./provider-stream.js";
import { logUsage } from "./session-helpers.js";
import type { SessionMemory } from "./session-memory.js";
import type { ToolContext } from "./tools.js";
import { loadStoredMessages, writeTranscriptLog } from "./transcript-log.js";
import type { FamiliarAgentSession } from "./types.js";

/** the per-session pieces a tool list is built from */
export type SessionToolParts = Pick<ToolContext, "mediaSink" | "referenceAttachments" | "agent">;

export interface AgentSessionSetup {
	config: Config;
	modelRuntime: ModelRuntime;
	memory: SessionMemory;
	sessionKey: string;
	sessionId: string;
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools(parts: SessionToolParts): AgentTool<any>[];
	deferredToolNames(): Set<string>;
}

export async function createAgentSession(setup: AgentSessionSetup): Promise<FamiliarAgentSession> {
	const { config, sessionKey, sessionId, model, thinkingLevel } = setup;
	const messages = await loadStoredMessages(config.workspace.dataDir, sessionId);
	console.log(`Loaded ${messages.length} prior messages from session history for ${sessionKey}`);
	const mediaSink = createGeneratedMediaSink();
	const referenceAttachments: StoredAttachment[] = [];
	// tools are built while the Agent is still being constructed; until then they read the stored history
	let agent: Agent | undefined;
	const stub = { state: { messages } } as Agent;
	const current = (): Agent => agent ?? stub;
	agent = new Agent({
		initialState: {
			systemPrompt: setup.systemPrompt,
			model,
			messages,
			tools: setup.tools({ mediaSink, referenceAttachments: () => referenceAttachments, agent: current }),
			thinkingLevel,
		},
		sessionId,
		// tool_search grows state.tools mid-run; the loop works from a snapshot, so refresh it each turn.
		prepareNextTurnWithContext: (turn) => ({ context: { ...turn.context, tools: current().state.tools.slice() } }),
		streamFn: createProviderStreamFn(config, setup.modelRuntime, { sessionId, sessionKey }),
		// the leading system message carries the prompt and tool declarations; keep it out of
		// memory's reach, which counts it through otherContextTokens instead.
		transformContext: async (contextMessages, signal) => {
			const head = contextMessages[0]?.role === "system" ? contextMessages[0] : undefined;
			const body = head ? contextMessages.slice(1) : contextMessages;
			const transformed = await setup.memory.transformContext(
				{ sessionKey, sessionId, agent: current() },
				body,
				signal,
			);
			pruneCondensedTools(current(), transformed, setup.deferredToolNames());
			return dropOrphanToolRemovals(head ? [head, ...transformed] : transformed);
		},
	});
	agent.subscribe((event) => {
		logUsage(event);
		setup.memory.observe({ sessionKey, sessionId, agent: current() }, event);
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
}

export function popLastAssistant(config: Config, session: FamiliarAgentSession, action: "retry" | "delete"): void {
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
}

export function editLastAssistant(config: Config, session: FamiliarAgentSession, text: string): void {
	const messages = session.agent.state.messages;
	const message = messages.at(-1);
	if (!message || message.role !== "assistant") {
		throw new Error("No assistant message to edit");
	}
	const edited = replaceAssistantTextContent(message, text);
	session.agent.state.messages = [...messages.slice(0, -1), edited];
	writeTranscriptLog(config, {
		ts: new Date().toISOString(),
		sessionId: session.sessionId,
		type: "supersede",
		messageTimestamp: message.timestamp,
	});
	writeTranscriptLog(config, {
		ts: new Date().toISOString(),
		sessionId: session.sessionId,
		message: edited,
	});
}

function replaceAssistantTextContent(message: AssistantMessage, text: string): AssistantMessage {
	let replaced = false;
	const content = message.content.map((part) => {
		if (part.type !== "text") return part;
		if (replaced) return { ...part, text: "" };
		replaced = true;
		return { ...part, text };
	});
	if (!replaced) throw new Error("Assistant message has no text to edit");
	return {
		...message,
		content,
		stopReason: "stop",
		errorMessage: undefined,
		timestamp: Math.max(Date.now(), message.timestamp + 1),
	};
}
