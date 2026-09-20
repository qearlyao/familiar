import type { Agent, AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Config, ThinkingLevel } from "../config/index.js";
import type { EffectiveSetting } from "../config/settings.js";
import type { StoredAttachment } from "../conversation/chat-log.js";
import type { GeneratedAttachment, GeneratedMediaSink } from "../media/generated-media.js";
import type { loadPersona } from "../prompting/persona.js";
import type { loadFamiliarSkills } from "../prompting/skills.js";
import type { McpHub } from "../tools/mcp.js";
import type { ContextBreakdown } from "../web/types.js";

export interface FamiliarAgentReply {
	text: string;
	attachments: GeneratedAttachment[];
}

export interface FamiliarPromptOptions {
	skipAmbient?: boolean;
	/** a session that leaves no trace in LCM memory (a voice call until it is kept) */
	ephemeral?: boolean;
	/** use this session's model and thinking level instead of its own */
	settingsFrom?: string;
	ambientQuery?: string;
	/** harness text sent ahead of the typed prompt as system notes (a kept voice call) */
	notes?: string[];
	referenceAttachments?: StoredAttachment[];
	onTurnEnd?: () => void | Promise<void>;
}

export interface FamiliarAgent {
	/** disconnect MCP servers */
	close(): Promise<void>;
	mcp: McpHub;
	/** hand every live session its tool list again after reach or pause changes */
	refreshTools(): Promise<void>;
	/** built-ins resting until the next restart */
	pausedTools(): ReadonlySet<string>;
	pauseTool(name: string, paused: boolean): Promise<void>;
	/** the tools a live session holds right now; empty when it hasn't started */
	toolNames(sessionKey: string): Promise<string[]>;
	getContextBreakdown(sessionKey: string, tokens: number): ContextBreakdown | undefined;
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
	abort(sessionKey: string): Promise<void>;
	/** abort and forget a short-lived session */
	dispose(sessionKey: string): Promise<void>;
	retryLastAssistant(
		sessionKey: string,
		onEvent?: (event: AgentEvent) => void | Promise<void>,
		options?: FamiliarPromptOptions,
	): Promise<FamiliarAgentReply>;
	deleteLastAssistant(sessionKey: string): Promise<void>;
	editLastAssistant(sessionKey: string, text: string): Promise<void>;
	reset(sessionKey: string): Promise<void>;
	reload(): Promise<string>;
	resolveChannelModel(sessionKey: string): { model: Model<any>; source: "config" | "override" };
	getModel(sessionKey: string): EffectiveSetting<string>;
	getThinkingLevel(sessionKey: string): EffectiveSetting<string>;
	setModel(sessionKey: string, input: string): Promise<string>;
	setThinkingLevel(sessionKey: string, input: string): Promise<string>;
}

export interface FamiliarAgentSession {
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
	modelRuntime?: ModelRuntime;
}

export interface ReloadSnapshot {
	config: Config;
	persona: Awaited<ReturnType<typeof loadPersona>>;
	skillsResult: ReturnType<typeof loadFamiliarSkills>;
	systemPrompt: string;
	defaultModel: Model<any>;
}

export interface ReloadedSession {
	session: FamiliarAgentSession;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool<any>[];
}
