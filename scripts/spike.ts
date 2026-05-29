import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { type Api, type Model, streamSimple } from "@earendil-works/pi-ai";
import { createBashTool } from "@earendil-works/pi-coding-agent";

function env(name: string, fallback: string): string {
	return process.env[name] ?? fallback;
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}

function createSpikeModel(): Model<Api> {
	const provider = process.env.FAMILIAR_SPIKE_PROVIDER ?? "anthropic";
	const modelId = env("FAMILIAR_SPIKE_MODEL", "claude-sonnet-4-5");
	return {
		id: modelId,
		name: modelId,
		api: env("FAMILIAR_SPIKE_API", "anthropic-messages"),
		provider,
		baseUrl: env("FAMILIAR_SPIKE_BASE_URL", "https://api.anthropic.com"),
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

function logUsage(event: AgentEvent): void {
	if (event.type !== "message_end" || event.message.role !== "assistant") return;
	const { usage } = event.message;
	console.log(
		JSON.stringify({
			type: "spike_usage",
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			input: usage.input,
			output: usage.output,
			cost: usage.cost.total,
		}),
	);
}

const apiKeyEnv = env("FAMILIAR_SPIKE_API_KEY_ENV", "ANTHROPIC_API_KEY");
const apiKey = requiredEnv(apiKeyEnv);
const model = createSpikeModel();
const cwd = process.env.FAMILIAR_SPIKE_CWD ?? process.cwd();
const agent = new Agent({
	initialState: {
		systemPrompt: "You are a minimal upstream integration spike. Keep replies short.",
		model,
		tools: [createBashTool(cwd)],
		thinkingLevel: "off",
	},
	sessionId: "familiar-stage-0-spike",
	streamFn: (streamModel, context, options) =>
		streamSimple(streamModel, context, {
			...options,
			apiKey,
			cacheRetention: "long",
		}),
});

agent.subscribe(logUsage);

await agent.prompt(process.env.FAMILIAR_SPIKE_PROMPT ?? "Say 'familiar spike ok' and do not use tools.");
