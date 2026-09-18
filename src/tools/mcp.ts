import type { AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Context, ImageContent, TextContent, Tool } from "@earendil-works/pi-ai/compat";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Type } from "typebox";
import type { Config } from "../config/index.js";

export interface McpHub {
	/** tools that ride along in every request */
	tools: AgentTool<any>[];
	/** tools that stay out of the request until load_tools brings them in */
	deferred: AgentTool<any>[];
	close(): Promise<void>;
}

const EMPTY_HUB: McpHub = { tools: [], deferred: [], close: async () => {} };

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

export async function connectMcpServers(config: Config): Promise<McpHub> {
	const entries = Object.entries(config.mcp.servers);
	if (entries.length === 0) return EMPTY_HUB;
	const hub: McpHub = { tools: [], deferred: [], close: async () => {} };
	const clients: Client[] = [];
	for (const [server, spec] of entries) {
		try {
			const transport = spec.url
				? new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } })
				: new StdioClientTransport({
						command: spec.command!,
						args: spec.args,
						env: { ...(process.env as Record<string, string>), ...spec.env },
						stderr: "ignore",
					});
			const { client, tools } = await connectMcpClient(server, transport);
			clients.push(client);
			(spec.deferred ? hub.deferred : hub.tools).push(...tools);
			const listChanged = client.getServerCapabilities()?.tools?.listChanged ? ", announces list changes" : "";
			console.log(
				`mcp: ${server} connected (${tools.length} tools${spec.deferred ? ", deferred" : ""}${listChanged})`,
			);
		} catch (error) {
			console.error(`mcp: ${server} failed to connect`, error);
		}
	}
	hub.close = async () => {
		await Promise.allSettled(clients.map((client) => client.close()));
	};
	return hub;
}

/** names a past tool result brought into the request; how loaded tools survive restarts and reloads */
export function loadedToolNames(messages: readonly AgentMessage[]): Set<string> {
	const names = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") for (const name of message.addedToolNames ?? []) names.add(name);
	}
	return names;
}

// once LCM condenses away both the load marker and every call, a loaded tool would ratchet into
// the cached prefix for good; drop it instead so it goes back to being loadable on demand.
export function pruneCondensedTools(context: Context, deferred: readonly AgentTool<any>[]): Tool[] {
	const tools = context.tools ?? [];
	if (deferred.length === 0) return tools;
	const alive = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "toolResult") for (const name of message.addedToolNames ?? []) alive.add(name);
		else if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") alive.add(block.name);
		}
	}
	const deferredNames = new Set(deferred.map((tool) => tool.name));
	return tools.filter((tool) => !deferredNames.has(tool.name) || alive.has(tool.name));
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
		description: `bring more tools into reach. these sit out of the way until you ask for them; name them or search by words and the matches become callable from your next turn. prefer names or a narrow query — a broad one loads everything it touches, and each loaded tool costs context until you're done with it. available: ${deferred.map((tool) => tool.name).join(", ")}`,
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
				addedToolNames: matches.map((tool) => tool.name),
			};
		},
	};
}
