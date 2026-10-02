import { createHash } from "node:crypto";
import type { Agent, AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { getCurrentTools, type JsonValue } from "@earendil-works/pi-ai";
import {
	McpClient,
	type McpTransport,
	StdioTransport,
	StreamableHttpTransport,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import { type TSchema, Type } from "typebox";
import type { McpExposure, McpServerConfig } from "../config/types.js";
import { createWriteQueue } from "../util/fs.js";
import type { McpSource } from "./mcp-servers.js";
import type { ToolNamespace } from "./tool-search.js";

export interface McpServerState {
	name: string;
	source: McpSource;
	spec: McpServerConfig;
	status: "connected" | "failed";
	error?: string;
	/** what the server says about itself on connect; heads its tools in codemode and tool_search */
	instructions?: string;
	tools: AgentTool<any>[];
}

export interface McpHub {
	/** the tools of every enabled server with this exposure */
	tools(exposure: McpExposure): AgentTool<any>[];
	/** the server a tool came from */
	namespaceOf(toolName: string): ToolNamespace | undefined;
	servers(): McpServerState[];
	/** connect what's new or changed, drop what's gone; an exposure flip alone never reconnects */
	sync(specs: Record<string, { spec: McpServerConfig; source: McpSource }>): Promise<void>;
	reconnect(name: string): Promise<void>;
	close(): Promise<void>;
}

/** provider tool names stop at 64 characters of [A-Za-z0-9_-] */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * `mcp__<server>__<tool>`, as pi names them: sanitized, and shortened with a hash suffix when too
 * long or when sanitizing collides with a name already taken.
 */
export function createMcpToolName(
	server: string,
	tool: string,
	isTaken: (name: string) => boolean = () => false,
): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
	if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/** every mcp tool's output schema: the CallToolResult scripts receive, with the tool's own schema as structuredContent */
function createMcpResultSchema(structuredContentSchema: Record<string, unknown> | undefined): TSchema {
	return {
		type: "object",
		properties: {
			content: { type: "array", items: { type: "object" } },
			...(structuredContentSchema ? { structuredContent: structuredContentSchema } : {}),
			isError: { type: "boolean" },
			_meta: { type: "object" },
		},
		required: ["content"],
	} as unknown as TSchema;
}

export async function connectMcpClient(
	server: string,
	transport: McpTransport,
): Promise<{ client: McpClient; tools: AgentTool<any>[] }> {
	const client = new McpClient({ name: "familiar", version: "1.0.0" });
	await client.connect(transport);
	const listed = await client.listTools();
	const names = new Set<string>();
	const tools = listed.map((tool): AgentTool<any> => {
		const name = createMcpToolName(server, tool.name, (candidate) => names.has(candidate));
		names.add(name);
		return {
			name,
			label: tool.title ?? tool.name,
			description: tool.description ?? tool.name,
			parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
			outputSchema: createMcpResultSchema(tool.outputSchema),
			async execute(_toolCallId, params, signal): Promise<AgentToolResult<undefined>> {
				const result = await client.callTool(tool.name, params as Record<string, unknown>, { signal });
				// scripts get the whole result; the model gets its content, as an error when the server says so
				const { _meta: _, ...structured } = result;
				return {
					content: toLlmContent(result),
					details: undefined,
					structuredContent: structured as unknown as JsonValue,
					...(result.isError ? { isError: true } : {}),
				};
			},
		};
	});
	return { client, tools };
}

function openTransport(spec: McpServerConfig): McpTransport {
	return spec.url
		? new StreamableHttpTransport({ url: spec.url, headers: spec.headers })
		: new StdioTransport({ command: spec.command!, args: spec.args, env: spec.env });
}

function sameTransport(a: McpServerConfig, b: McpServerConfig): boolean {
	return JSON.stringify({ ...a, exposure: undefined }) === JSON.stringify({ ...b, exposure: undefined });
}

/** onChange fires after the tool set shifts, so live sessions can rebuild their tool lists */
export function createMcpHub(onChange: () => void | Promise<void> = () => {}): McpHub {
	const states = new Map<string, McpServerState & { client?: McpClient }>();
	const serial = createWriteQueue("mcp");
	const enabled = () => [...states.values()].filter((state) => state.spec.enabled);

	const connect = async (name: string, spec: McpServerConfig, source: McpSource): Promise<void> => {
		await states.get(name)?.client?.close();
		const state: McpServerState & { client?: McpClient } = { name, source, spec, status: "failed", tools: [] };
		states.set(name, state);
		if (!spec.enabled) return;
		try {
			const { client, tools } = await connectMcpClient(name, openTransport(spec));
			Object.assign(state, { client, tools, status: "connected", instructions: client.instructions });
			const listChanged = client.serverCapabilities?.tools?.listChanged ? ", announces list changes" : "";
			console.log(`mcp: ${name} connected (${tools.length} tools, ${spec.exposure}${listChanged})`);
		} catch (error) {
			state.error = error instanceof Error ? error.message : String(error);
			console.error(`mcp: ${name} failed to connect`, error);
		}
	};

	return {
		tools: (exposure) => enabled().flatMap((state) => (state.spec.exposure === exposure ? state.tools : [])),
		namespaceOf: (toolName) => {
			const state = enabled().find((candidate) => candidate.tools.some((tool) => tool.name === toolName));
			return state && { name: state.name, description: state.instructions };
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
							if (current.spec.exposure === spec.exposure && current.source === source) return;
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
// tool_search can bring it back on demand.
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

// LCM condenses tool-change system messages like any other, so a removal can outlive the
// declaration it withdraws — pruneCondensedTools always produces one. anthropic rejects that
// (tool_reference_unresolved), so the request drops removals of tools it never declared.
export function dropOrphanToolRemovals(messages: AgentMessage[]): AgentMessage[] {
	const declared = new Set<string>();
	return messages.map((message) => {
		if (message.role !== "system") return message;
		const toolsRemoved = message.toolsRemoved?.filter((tool) => declared.has(tool.name));
		for (const tool of message.toolsAdded ?? []) declared.add(tool.name);
		return toolsRemoved?.length === message.toolsRemoved?.length ? message : { ...message, toolsRemoved };
	});
}
