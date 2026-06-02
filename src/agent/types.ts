import type { Agent, AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { StoredAttachment } from "../chat-log.js";
import type { Config, ThinkingLevel } from "../config.js";
import type { GeneratedAttachment, GeneratedMediaSink } from "../generated-media.js";
import type { loadPersona } from "../persona.js";
import type { EffectiveSetting } from "../settings.js";
import type { loadFamiliarSkills } from "../skills.js";

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
	abort(sessionKey: string): Promise<void>;
	retryLastAssistant(
		sessionKey: string,
		onEvent?: (event: AgentEvent) => void | Promise<void>,
		options?: FamiliarPromptOptions,
	): Promise<FamiliarAgentReply>;
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
