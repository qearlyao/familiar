import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTextTokens } from "../memory/lcm/context.js";
import type { ContextBreakdown } from "../memory/lcm/types.js";
import type { MemoryService } from "../memory/service.js";
import type { FamiliarPromptOptions } from "./types.js";

export type SessionMemory = ReturnType<typeof createSessionMemory>;

/** how memory rides along every agent session: ambient recall and LCM shape the context each
    request sees, finished turns are recorded into LCM, and the last request's context breakdown
    is kept for the UI. Per-turn prompt options decide which of those a turn opts out of. */
export function createSessionMemory(memory: MemoryService) {
	const completedContexts = new Map<string, { tokens: number; breakdown: ContextBreakdown }>();
	// activeOptions covers each prompt window; skipAmbientMessages tags message identities so
	// followUpMessage's fire-and-forget path also opts out.
	const activeOptions = new Map<string, FamiliarPromptOptions>();
	const skipAmbientMessages = new WeakSet<AgentMessage & object>();

	const lastUserMessageSkipsAmbient = (messages: readonly AgentMessage[]): boolean => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (!message || typeof message !== "object" || !("role" in message)) continue;
			if (message.role !== "user" && message.role !== "system") continue;
			return skipAmbientMessages.has(message);
		}
		return false;
	};

	return {
		/** scope a turn's prompt options to its run; the returned exit restores the enclosing ones */
		enterTurn(sessionKey: string, options: FamiliarPromptOptions): () => void {
			const previous = activeOptions.get(sessionKey);
			activeOptions.set(sessionKey, options);
			return () => {
				if (previous) activeOptions.set(sessionKey, previous);
				else activeOptions.delete(sessionKey);
			};
		},

		skipAmbientFor(message: AgentMessage): void {
			skipAmbientMessages.add(message);
		},

		/** the context body (system head already set aside) as memory reshapes it for this request */
		transformContext(
			session: { sessionKey: string; sessionId: string; agent: Agent },
			body: AgentMessage[],
			signal?: AbortSignal,
		): Promise<AgentMessage[]> {
			const { sessionKey, sessionId, agent } = session;
			const options = activeOptions.get(sessionKey);
			const skipAmbient = options?.skipAmbient || lastUserMessageSkipsAmbient(body);
			return memory.transformContext(body, signal, {
				sessionKey,
				sessionId,
				model: agent.state.model,
				// JSON.stringify drops each tool's execute function on its own.
				otherContextTokens:
					estimateTextTokens(agent.state.systemPrompt) + estimateTextTokens(JSON.stringify(agent.state.tools)),
				...(skipAmbient ? { skipAmbient: true } : {}),
				...(options?.ephemeral ? { skipLcm: true } : {}),
				...(options?.ambientQuery !== undefined ? { ambientQuery: options.ambientQuery } : {}),
			});
		},

		observe(session: { sessionKey: string; sessionId: string; agent: Agent }, event: AgentEvent): void {
			const { sessionKey, sessionId, agent } = session;
			if (event.type === "message_end" && event.message.role === "assistant") {
				const breakdown = memory.getContextBreakdown(sessionKey);
				const usage = event.message.usage;
				if (breakdown) {
					completedContexts.set(sessionKey, {
						tokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
						breakdown,
					});
				} else completedContexts.delete(sessionKey);
			}
			if (event.type === "agent_end" && !activeOptions.get(sessionKey)?.ephemeral) {
				const messages = agent.state.messages;
				try {
					memory.recordMessages(messages[0]?.role === "system" ? messages.slice(1) : messages, {
						sessionKey,
						sessionId,
					});
				} catch (error) {
					console.error(`memory LCM turn recording failed for ${sessionKey}`, error);
				}
			}
		},

		/** the breakdown of the last completed request, while `tokens` still describes it */
		contextBreakdown(sessionKey: string, tokens: number): ContextBreakdown | undefined {
			const completed = completedContexts.get(sessionKey);
			return completed?.tokens === tokens ? completed.breakdown : undefined;
		},

		forget(sessionKey: string): void {
			completedContexts.delete(sessionKey);
		},
	};
}
