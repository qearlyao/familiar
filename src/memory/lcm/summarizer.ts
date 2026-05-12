import { readFile } from "node:fs/promises";

import {
	type Api,
	type AssistantMessage,
	completeSimple,
	type Message,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";

import type { Config } from "../../config.js";
import { assertModelCanAuthenticate, parseModelRef, resolveModel, resolveModelApiKey } from "../../models.js";

export type LcmSummaryMode = "normal" | "aggressive";

export interface LcmSummarizer {
	summarizeLeaf(input: LcmLeafSummaryInput, signal?: AbortSignal): Promise<string>;
	summarizeCondensed?(input: LcmCondensedSummaryInput, signal?: AbortSignal): Promise<string>;
}

export interface LcmLeafSummaryInput {
	text: string;
	targetTokens: number;
	mode?: LcmSummaryMode;
	previousSummary?: string;
}

export interface LcmCondensedSummaryInput {
	text: string;
	targetTokens: number;
	depth: number;
	childSummaryCount: number;
}

export type LcmCompleteFn = (
	model: Model<Api>,
	context: { systemPrompt?: string; messages: Message[] },
	options: {
		apiKey?: string;
		maxTokens?: number;
		timeoutMs?: number;
		signal?: AbortSignal;
		cacheRetention?: "none" | "short" | "long";
	},
) => Promise<AssistantMessage>;

export const LCM_SUMMARIZER_SYSTEM_PROMPT =
	"You are a private continuity summarizer. Preserve what helps the companion agent remember the user with care, accuracy, and emotional tact. Return plain text summary content only.";

export class DefaultLcmSummarizer implements LcmSummarizer {
	private readonly complete: LcmCompleteFn;
	private promptOverride: Promise<string | undefined> | undefined;
	private systemPromptOverride: Promise<string | undefined> | undefined;

	constructor(
		private readonly config: Config,
		complete: LcmCompleteFn = completeSimple,
	) {
		this.complete = complete;
	}

	async summarizeLeaf(input: LcmLeafSummaryInput, signal?: AbortSignal): Promise<string> {
		const targetTokens = Math.max(1, Math.floor(input.targetTokens));
		const prompt = await this.buildPrompt({ ...input, targetTokens });
		const text = await this.runCompletion(prompt, targetTokens, signal);
		return capSummaryText(text || fallbackSummary(input.text), targetTokens);
	}

	async summarizeCondensed(input: LcmCondensedSummaryInput, signal?: AbortSignal): Promise<string> {
		const targetTokens = Math.max(1, Math.floor(input.targetTokens));
		const prompt = await this.buildCondensedPrompt({ ...input, targetTokens });
		const text = await this.runCompletion(prompt, targetTokens, signal);
		return capSummaryText(text || fallbackSummary(input.text), targetTokens);
	}

	private resolveModel(): Model<Api> {
		const settings = this.config.memory.lcm;
		if (!settings.enabled) throw new Error("LCM is disabled");
		const ref = parseModelRef(settings.model);
		if (!ref) throw new Error(`Invalid memory.lcm.model: ${settings.model}`);
		const base = resolveModel(ref, this.config) as Model<Api>;
		const model = {
			...base,
			...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
		};
		assertModelCanAuthenticate(this.config, model);
		return model;
	}

	private resolveApiKey(model: Model<Api>): string | undefined {
		const settings = this.config.memory.lcm;
		if (settings?.apiKeyEnv) return process.env[settings.apiKeyEnv];
		return resolveModelApiKey(this.config, model);
	}

	private async buildPrompt(input: LcmLeafSummaryInput): Promise<string> {
		const override = await this.readPromptOverride();
		return buildLeafSummaryPrompt({
			...input,
			mode: input.mode ?? "normal",
			customInstructions: override,
		});
	}

	private async buildCondensedPrompt(input: LcmCondensedSummaryInput): Promise<string> {
		const override = await this.readPromptOverride();
		return buildCondensedSummaryPrompt({ ...input, customInstructions: override });
	}

	private async runCompletion(prompt: string, targetTokens: number, signal?: AbortSignal): Promise<string> {
		const settings = this.config.memory.lcm;
		if (!settings.enabled) throw new Error("LCM is disabled");
		const model = this.resolveModel();
		const systemPrompt = (await this.readSystemPromptOverride()) ?? LCM_SUMMARIZER_SYSTEM_PROMPT;
		const response = await this.complete(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			},
			{
				apiKey: this.resolveApiKey(model),
				maxTokens: Math.max(targetTokens + 256, Math.ceil(targetTokens * 1.25)),
				timeoutMs: settings.timeoutMs,
				signal,
				cacheRetention: "none",
			},
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage || `LCM summarizer stopped with ${response.stopReason}`);
		}
		return extractAssistantText(response).trim();
	}

	private readPromptOverride(): Promise<string | undefined> {
		this.promptOverride ??= readConfiguredPrompt(this.config.memory.lcm.prompt, this.config.memory.lcm.promptPath);
		return this.promptOverride;
	}

	private readSystemPromptOverride(): Promise<string | undefined> {
		this.systemPromptOverride ??= readConfiguredPrompt(
			this.config.memory.lcm.systemPrompt,
			this.config.memory.lcm.systemPromptPath,
		);
		return this.systemPromptOverride;
	}
}

export function buildLeafSummaryPrompt(params: {
	text: string;
	mode: LcmSummaryMode;
	targetTokens: number;
	previousSummary?: string;
	customInstructions?: string;
}): string {
	const previousContext = params.previousSummary?.trim() || "(none)";
	const policy =
		params.mode === "aggressive"
			? [
					"Aggressive summary policy:",
					"- Keep only durable emotional context, user preferences, explicit commitments, active plans, and facts likely to matter later.",
					"- Remove repetition, transient wording, and momentary mood details unless they reveal an ongoing need or boundary.",
					"- Preserve unresolved tensions, sensitive topics, and current support needs with careful wording.",
				].join("\n")
			: [
					"Normal summary policy:",
					"- Preserve what helps the companion agent continue as a warm partner: user preferences, feelings, relationship context, promises, boundaries, plans, and decisions.",
					"- Keep technical/project details only when they are part of the user's ongoing life, work, or shared context.",
					"- Remove obvious repetition, filler, and private momentary phrasing that does not need to be remembered.",
				].join("\n");
	const instructionBlock = params.customInstructions?.trim()
		? `Additional operator instructions:\n${params.customInstructions.trim()}`
		: "Additional operator instructions: (none)";

	return [
		"You summarize a SEGMENT of a companion conversation for future model turns.",
		"Treat this as incremental continuity memory, not a full transcript and not a coding handoff.",
		policy,
		instructionBlock,
		[
			"Output requirements:",
			"- Plain text only.",
			"- No preamble, headings, or markdown formatting.",
			"- Keep it concise, specific, and emotionally neutral; do not dramatize or infer more than the segment supports.",
			"- Mention files, commands, or implementation details only when they are needed for an active user goal.",
			'- End with exactly: "Compressed away: <comma-separated list of what was dropped or generalized>".',
			`- Target length: about ${Math.max(1, Math.floor(params.targetTokens))} tokens or less.`,
		].join("\n"),
		`<previous_context>\n${previousContext}\n</previous_context>`,
		`<conversation_segment>\n${params.text}\n</conversation_segment>`,
	].join("\n\n");
}

export function buildCondensedSummaryPrompt(params: {
	text: string;
	targetTokens: number;
	depth: number;
	childSummaryCount: number;
	customInstructions?: string;
}): string {
	if (params.depth <= 2) return buildSessionSummaryPrompt(params);
	if (params.depth === 3) return buildTrajectorySummaryPrompt(params);
	return buildDurableSummaryPrompt(params);
}

function buildSessionSummaryPrompt(params: {
	text: string;
	targetTokens: number;
	childSummaryCount: number;
	customInstructions?: string;
}): string {
	const instructionBlock = additionalInstructions(params.customInstructions);
	return [
		"You are merging several recent memory notes into one session-level continuity memory.",
		"Focus on what is new, changed, resolved, or still active across these notes.",
		instructionBlock,
		[
			"Preserve:",
			"- The user's preferences, boundaries, emotional state, and important relationship context.",
			"- Active plans, promises, requests, open loops, and decisions that should be remembered.",
			"- Work/project details only when they remain relevant for continuation.",
			"",
			"Drop:",
			"- Turn-by-turn narration, repeated reassurance, and resolved small talk.",
			"- Tool/process details unless they affect the user's next step.",
			"",
			"Use plain text. Brief structure is allowed if it improves scanability.",
			`Input contains ${params.childSummaryCount} child summaries.`,
			'- End with exactly: "Compressed away: <comma-separated list of what was dropped or generalized>".',
			`Target length: about ${Math.max(1, Math.floor(params.targetTokens))} tokens.`,
		].join("\n"),
		`<memory_notes_to_merge>\n${params.text}\n</memory_notes_to_merge>`,
	].join("\n\n");
}

function buildTrajectorySummaryPrompt(params: {
	text: string;
	targetTokens: number;
	childSummaryCount: number;
	customInstructions?: string;
}): string {
	const instructionBlock = additionalInstructions(params.customInstructions);
	return [
		"You are merging session-level memories into a trajectory-level continuity memory.",
		"A future companion agent should understand the user's ongoing patterns and current state without replaying session minutiae.",
		instructionBlock,
		[
			"Preserve:",
			"- Stable preferences, values, boundaries, and repeated emotional themes.",
			"- Important changes in the user's plans, relationships, work, or self-understanding.",
			"- Current unresolved needs, promises, risks, and active projects.",
			"",
			"Drop:",
			"- Session-local operational detail and short-lived mood shifts.",
			"- Intermediate states superseded by later outcomes.",
			"",
			"Use plain text with concise labels if useful.",
			`Input contains ${params.childSummaryCount} child summaries.`,
			'- End with exactly: "Compressed away: <comma-separated list of what was dropped or generalized>".',
			`Target length: about ${Math.max(1, Math.floor(params.targetTokens))} tokens.`,
		].join("\n"),
		`<memory_notes_to_merge>\n${params.text}\n</memory_notes_to_merge>`,
	].join("\n\n");
}

function buildDurableSummaryPrompt(params: {
	text: string;
	targetTokens: number;
	childSummaryCount: number;
	customInstructions?: string;
}): string {
	const instructionBlock = additionalInstructions(params.customInstructions);
	return [
		"You are creating a durable continuity memory from higher-level summaries.",
		"This memory may persist for a long time. Keep only stable, useful context.",
		instructionBlock,
		[
			"Preserve:",
			"- Durable facts about the user, their preferences, values, boundaries, and relationship with the companion agent.",
			"- Long-running projects, commitments, unresolved tensions, and lessons learned.",
			"- Important care instructions: what helps, what harms, and what should be handled gently.",
			"",
			"Drop:",
			"- Operational details, transient conversation flow, and details that no longer affect future support.",
			"- Specific names, paths, or identifiers unless they remain essential.",
			"",
			"Use plain text. Be compact and careful.",
			`Input contains ${params.childSummaryCount} child summaries.`,
			'- End with exactly: "Compressed away: <comma-separated list of what was dropped or generalized>".',
			`Target length: about ${Math.max(1, Math.floor(params.targetTokens))} tokens.`,
		].join("\n"),
		`<memory_notes_to_merge>\n${params.text}\n</memory_notes_to_merge>`,
	].join("\n\n");
}

function additionalInstructions(value: string | undefined): string {
	return value?.trim()
		? `Additional operator instructions:\n${value.trim()}`
		: "Additional operator instructions: (none)";
}

export function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

export function capSummaryText(text: string, targetTokens: number): string {
	const normalized = text.trim() || fallbackSummary("");
	const maxChars = Math.max(200, Math.floor(Math.max(1, targetTokens) * 4));
	if (normalized.length <= maxChars) return normalized;
	const clipped = normalized
		.slice(0, maxChars)
		.replace(/\s+\S*$/, "")
		.trim();
	return `${clipped || normalized.slice(0, maxChars).trim()}\nCompressed away: overflow beyond summary cap`;
}

function fallbackSummary(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	const excerpt = normalized ? normalized.slice(0, 400).trim() : "No durable content was available to summarize.";
	return `${excerpt}\nCompressed away: details unavailable due to empty summarizer output`;
}

export function createSyntheticLcmSummaryMessage(text: string, timestamp = Date.now()): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "lcm-summary" as Api,
		provider: "familiar" as Provider,
		model: "lcm-summary",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

async function readConfiguredPrompt(inline: string | undefined, path: string | undefined): Promise<string | undefined> {
	if (inline?.trim()) return inline.trim();
	if (!path) return undefined;
	const text = (await readFile(path, "utf8")).trim();
	return text || undefined;
}
