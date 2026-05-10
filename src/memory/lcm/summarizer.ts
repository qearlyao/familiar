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
}

export interface LcmLeafSummaryInput {
	text: string;
	targetTokens: number;
	mode?: LcmSummaryMode;
	previousSummary?: string;
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
	"You are a context-compaction summarization engine. Follow user instructions exactly and return plain text summary content only.";

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
		const settings = this.config.memory.lcm;
		if (!settings.enabled) throw new Error("LCM is disabled");
		const model = this.resolveModel();
		const targetTokens = Math.max(1, Math.floor(input.targetTokens));
		const prompt = await this.buildPrompt({ ...input, targetTokens });
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
		const text = extractAssistantText(response).trim();
		if (!text) throw new Error("LCM summarizer returned an empty summary");
		return text;
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
					"- Keep only durable facts and current task state.",
					"- Remove examples, repetition, and low-value narrative details.",
					"- Preserve explicit TODOs, blockers, decisions, and constraints.",
				].join("\n")
			: [
					"Normal summary policy:",
					"- Preserve key decisions, rationale, constraints, and active tasks.",
					"- Keep essential technical details needed to continue work safely.",
					"- Remove obvious repetition and conversational filler.",
				].join("\n");
	const instructionBlock = params.customInstructions?.trim()
		? `Operator instructions:\n${params.customInstructions.trim()}`
		: "Operator instructions: (none)";

	return [
		"You summarize a SEGMENT of a Familiar conversation for future model turns.",
		"Treat this as incremental memory compaction input, not a full-conversation summary.",
		policy,
		instructionBlock,
		[
			"Output requirements:",
			"- Plain text only.",
			"- No preamble, headings, or markdown formatting.",
			"- Keep it concise while preserving required details.",
			"- Track file operations (created, modified, deleted, renamed) with file paths and current status.",
			'- If no file operations appear, include exactly: "Files: none".',
			'- End with exactly: "Expand for details about: <comma-separated list of what was dropped or compressed>".',
			`- Target length: about ${Math.max(1, Math.floor(params.targetTokens))} tokens or less.`,
		].join("\n"),
		`<previous_context>\n${previousContext}\n</previous_context>`,
		`<conversation_segment>\n${params.text}\n</conversation_segment>`,
	].join("\n\n");
}

export function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
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
