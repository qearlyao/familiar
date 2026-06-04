import { readFile } from "node:fs/promises";

import {
	type Api,
	type AssistantMessage,
	completeSimple,
	type Message,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";

import type { Config } from "../../config/index.js";
import { assertModelCanAuthenticate, parseModelRef, resolveModel, resolveModelApiKey } from "../../models/index.js";

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
	"You write continuity memory for a companion agent — notes it reads back later to stay close to a real person it talks with. Raw conversation history is preserved separately; the agent can search it on demand. Summaries aren't the last copy of anything — they're the index that lets the agent know what to look up. Preserve emotional shape and retrieval scent. Keep the moments that mattered emotionally over the ones that were lexically rich. Accurate, specific, understated. Don't dramatize, don't flatten. Plain text only.";

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
					"Aggressive summary policy — compress hard.",
					"- Keep the emotional throughline, the user's preferences and commitments, active plans, and anything likely to matter weeks from now.",
					"- Keep the emotional shape of load-bearing moments, named clearly enough that the agent can find the original text in memory if it wants the detail. Drop the routine substrate around them.",
					"- Preserve unresolved tensions, sensitive topics, and ongoing support needs. Handle them with care; don't flatten them into bullet points.",
					"- Drop turn-by-turn narration and resolved small talk.",
				].join("\n")
			: [
					"Normal summary policy:",
					"- Keep what helps the agent stay close to the user: how they're feeling, what they care about, what they've asked for, what they're working on, what's still open between them.",
					"- Quote specific phrasing only when paraphrase would lose what made it land — otherwise, name the moment (a joke, a vulnerable line, a tone shift) clearly enough that the agent could pull the original via search. Drop routine acknowledgments, small-talk filler, and repeated rephrasings.",
					"- Keep technical or project detail when it's part of the user's life or something they're carrying together. Drop it when it was passing through.",
				].join("\n");
	const instructionBlock = params.customInstructions?.trim()
		? `Additional operator instructions:\n${params.customInstructions.trim()}`
		: "Additional operator instructions: (none)";

	return [
		"Summarize a SEGMENT of a companion conversation so the agent can pick the thread up later. Incremental continuity memory — not a transcript, not a coding handoff.",
		policy,
		instructionBlock,
		[
			"Output:",
			"- Plain text. No preamble, no headings, no markdown.",
			"- Concise and specific. Emotionally accurate but understated — don't dramatize, don't flatten.",
			"- Don't infer beyond what the segment supports.",
			"- Name significant topics, people, and moments clearly — vague pronouns and stripped proper nouns make later search miss them.",
			"- Mention files, commands, or implementation details only when they're load-bearing for something the user is actively doing.",
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
		"You're merging several recent memory notes into one session-level continuity memory. Focus on what's new, changed, resolved, or still active across them.",
		instructionBlock,
		[
			"Keep:",
			"- The user's preferences, boundaries, emotional state, and what's actually been moving in the relationship.",
			"- Active plans, promises, requests, open loops, decisions.",
			"- Specific phrasing or moments when they were the thing that mattered — a line that landed, a tone shift, an inside reference.",
			"- Work or project detail when it stays relevant going forward.",
			"",
			"Drop:",
			"- Turn-by-turn narration, repeated reassurance, resolved small talk.",
			"- Tool or process detail unless it shapes what the user does next.",
			"- Intermediate phrasing that's been superseded by later wording.",
			"",
			"Plain text. Brief structure (short labels, light grouping) is fine if it helps the agent scan it later.",
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
		"You're merging session-level memories into a trajectory-level continuity memory. A future companion agent should be able to understand the user's ongoing patterns and current state without replaying session minutiae.",
		instructionBlock,
		[
			"Keep:",
			"- Stable preferences, values, boundaries, and recurring emotional themes (not single moments — patterns).",
			"- Important changes in the user's plans, relationships, work, or self-understanding.",
			"- Current unresolved needs, promises, risks, and active projects.",
			"- Moments singular enough to matter at trajectory scale — a turning point, a first time, a hard line drawn.",
			"",
			"Drop:",
			"- Session-local operational detail and one-off mood shifts.",
			"- Intermediate states superseded by later outcomes.",
			"",
			"Plain text with concise labels if useful.",
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
		"You're distilling higher-level summaries into a durable continuity memory. This may persist for a long time — keep only what stays true and useful.",
		instructionBlock,
		[
			"Keep:",
			"- Durable facts about the user — preferences, values, boundaries, and the shape of their relationship with the agent.",
			"- Long-running projects, commitments, unresolved tensions, and lessons learned over time.",
			"- Care instructions: what helps, what harms, what should be handled gently.",
			"",
			"Drop:",
			"- Operational detail, transient conversation flow, and anything that no longer affects future support.",
			"- Specific names, paths, or identifiers unless they remain essential.",
			"",
			"Plain text. Be compact and careful.",
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
