import type { Agent, AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { getCurrentTools } from "@earendil-works/pi-ai";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Type } from "typebox";
import type { McpServerConfig } from "../config/types.js";
import { createWriteQueue } from "../util/fs.js";
import type { McpSource } from "./mcp-servers.js";

export interface McpServerState {
	name: string;
	source: McpSource;
	spec: McpServerConfig;
	status: "connected" | "failed";
	error?: string;
	tools: AgentTool<any>[];
}

export interface McpHub {
	/** tools that ride along in every request */
	readonly tools: AgentTool<any>[];
	/** tools that stay out of the request until load_tools brings them in */
	readonly deferred: AgentTool<any>[];
	servers(): McpServerState[];
	/** connect what's new or changed, drop what's gone; a deferred flip alone never reconnects */
	sync(specs: Record<string, { spec: McpServerConfig; source: McpSource }>): Promise<void>;
	reconnect(name: string): Promise<void>;
	close(): Promise<void>;
}

function toolName(server: string, name: string): string {
	return `${server}__${name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

export async function connectMcpClient(
	server: string,
	transport: Transport,
): Promise<{ client: Client; tools: AgentTool<any>[] }> {
	const client = new Client({ name: "familiar", version: "1.0.0" });
	await client.connect(transport);
	const { tools } = await client.listTools();
	return {
		client,
		tools: tools.map((tool) => ({
			name: toolName(server, tool.name),
			label: tool.title ?? tool.name,
			description: tool.description ?? tool.name,
			parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
			async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
				const result = await client.callTool(
					{ name: tool.name, arguments: params as Record<string, unknown> },
					undefined,
					{ signal },
				);
				const blocks = (result.content ?? []) as Array<{
					type: string;
					text?: string;
					data?: string;
					mimeType?: string;
				}>;
				const content: (TextContent | ImageContent)[] = [];
				for (const block of blocks) {
					if (block.type === "text" && block.text !== undefined) content.push({ type: "text", text: block.text });
					else if (block.type === "image" && block.data && block.mimeType) {
						content.push({ type: "image", data: block.data, mimeType: block.mimeType });
					}
				}
				if (result.structuredContent && content.length === 0) {
					content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
				}
				if (result.isError)
					throw new Error(content.map((block) => (block.type === "text" ? block.text : "")).join("\n"));
				return { content, details: result.structuredContent };
			},
		})),
	};
}

function openTransport(spec: McpServerConfig): Transport {
	return spec.url
		? new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } })
		: new StdioClientTransport({
				command: spec.command!,
				args: spec.args,
				env: { ...(process.env as Record<string, string>), ...spec.env },
				stderr: "ignore",
			});
}

function sameTransport(a: McpServerConfig, b: McpServerConfig): boolean {
	return JSON.stringify({ ...a, deferred: undefined }) === JSON.stringify({ ...b, deferred: undefined });
}

/** onChange fires after the tool set shifts, so live sessions can rebuild their tool lists */
export function createMcpHub(onChange: () => void | Promise<void> = () => {}): McpHub {
	const states = new Map<string, McpServerState & { client?: Client }>();
	const serial = createWriteQueue("mcp");
	const pick = (deferred: boolean) =>
		[...states.values()].flatMap((state) => (state.spec.deferred === deferred ? state.tools : []));

	const connect = async (name: string, spec: McpServerConfig, source: McpSource): Promise<void> => {
		await states.get(name)?.client?.close();
		const state: McpServerState & { client?: Client } = { name, source, spec, status: "failed", tools: [] };
		states.set(name, state);
		try {
			const { client, tools } = await connectMcpClient(name, openTransport(spec));
			Object.assign(state, { client, tools, status: "connected" });
			const listChanged = client.getServerCapabilities()?.tools?.listChanged ? ", announces list changes" : "";
			console.log(
				`mcp: ${name} connected (${tools.length} tools${spec.deferred ? ", deferred" : ""}${listChanged})`,
			);
		} catch (error) {
			state.error = error instanceof Error ? error.message : String(error);
			console.error(`mcp: ${name} failed to connect`, error);
		}
	};

	return {
		get tools() {
			return pick(false);
		},
		get deferred() {
			return pick(true);
		},
		servers: () => [...states.values()].map(({ client: _client, ...state }) => state),
		sync: (specs) =>
			serial(async () => {
				let changed = false;
				for (const [name, state] of states) {
					if (name in specs) continue;
					await state.client?.close();
					states.delete(name);
					changed = true;
				}
				await Promise.all(
					Object.entries(specs).map(async ([name, { spec, source }]) => {
						const current = states.get(name);
						if (current && sameTransport(current.spec, spec)) {
							if (current.spec.deferred === spec.deferred && current.source === source) return;
							Object.assign(current, { spec, source });
						} else await connect(name, spec, source);
						changed = true;
					}),
				);
				if (changed) await onChange();
			}),
		reconnect: async (name) => {
			if (!states.has(name)) throw new Error(`no mcp server named ${name}`);
			await serial(async () => {
				const state = states.get(name);
				if (!state) return;
				await connect(name, state.spec, state.source);
				await onChange();
			});
		},
		close: async () => {
			await Promise.allSettled([...states.values()].map((state) => state.client?.close()));
		},
	};
}

/** every tool the transcript's system messages currently declare; how loaded tools survive restarts and reloads */
export function loadedToolNames(messages: readonly AgentMessage[]): Set<string> {
	return new Set(getCurrentTools(messages).map((tool) => tool.name));
}

// once LCM condenses away the system message that declared a loaded tool, the request stops
// offering it; drop it from the loadout too so the transcript announces the removal and
// load_tools can bring it back on demand.
export function pruneCondensedTools(
	agent: Agent,
	transformed: readonly AgentMessage[],
	deferredNames: ReadonlySet<string>,
): void {
	if (deferredNames.size === 0) return;
	const declared = loadedToolNames(transformed);
	const kept = agent.state.tools.filter((tool) => !deferredNames.has(tool.name) || declared.has(tool.name));
	if (kept.length !== agent.state.tools.length) agent.state.tools = kept;
}

const loadToolsSchema = Type.Object({
	query: Type.Optional(
		Type.String({ description: "words to match against tool names and descriptions. empty lists everything." }),
	),
	names: Type.Optional(
		Type.Array(Type.String(), { description: "exact tool names to load, when you already know them." }),
	),
});

/** the one tool that fetches the rest; whatever it returns is usable from the next turn on */
export function createLoadToolsTool(
	deferred: readonly AgentTool<any>[],
	onLoad: (tools: AgentTool<any>[]) => void,
): AgentTool<typeof loadToolsSchema> {
	return {
		name: "load_tools",
		label: "Load Tools",
		description: `bring more tools into reach; they become callable from your next turn. prefer names or a narrow query — a broad one loads everything it touches, and loaded tools cost context. available: ${deferred.map((tool) => tool.name).join(", ")}`,
		parameters: loadToolsSchema,
		async execute(_toolCallId, params) {
			const names = new Set(params.names ?? []);
			const query = params.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
			const matches = deferred.filter(
				(tool) =>
					names.has(tool.name) ||
					(names.size === 0 &&
						query.every((word) => `${tool.name} ${tool.description}`.toLowerCase().includes(word))),
			);
			if (matches.length === 0) return { content: [{ type: "text", text: "nothing matched." }], details: undefined };
			onLoad(matches);
			return {
				content: [{ type: "text", text: matches.map((tool) => `${tool.name}: ${tool.description}`).join("\n\n") }],
				details: undefined,
			};
		},
	};
}
