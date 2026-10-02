import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOLS, MCP_EXPOSURES } from "../config/enums.js";
import type { Config, ToolReach } from "../config/index.js";
import type { StoredAttachment } from "../conversation/chat-log.js";
import type { GeneratedMediaSink } from "../media/generated-media.js";
import { createImageGenTool } from "../media/image-gen.js";
import { createSendFileTool } from "../media/send-file.js";
import { createTtsTool } from "../media/tts.js";
import type { MemoryService } from "../memory/service.js";
import { createBrowserTools } from "../tools/browser-tools.js";
import { createCodemodeTool } from "../tools/codemode.js";
import { createCronTool } from "../tools/cron.js";
import { loadedToolNames, type McpHub } from "../tools/mcp.js";
import { createToolSearchTool } from "../tools/tool-search.js";
import { createWebTools } from "../web-tools/index.js";
import { BASH_DESCRIPTION, EDIT_DESCRIPTION, READ_DESCRIPTION, WRITE_DESCRIPTION } from "./tool-descriptions.js";
import type { FamiliarAgentSession } from "./types.js";

/** everything a session's tools are built from; one per session, rebuilt whenever its tool list is */
export interface ToolContext {
	config: Config;
	mediaSink: GeneratedMediaSink;
	referenceAttachments: () => readonly StoredAttachment[];
	memory: MemoryService;
	mcp: McpHub;
	agent: () => Agent;
	paused: ReadonlySet<string>;
}

function withDescription(tool: AgentTool<any>, description: string): AgentTool<any> {
	tool.description = description;
	return tool;
}

/** a paused tool is off until the next restart, whatever its lasting reach says */
export function toolReach(config: Config, paused: ReadonlySet<string>, name: string): ToolReach {
	return paused.has(name) ? "off" : (config.tools.reach[name] ?? "pinned");
}

export function createFamiliarTools(ctx: ToolContext): AgentTool<any>[] {
	const { config, mediaSink, mcp, paused } = ctx;
	// every built-in but codemode, which wraps the others; names match BUILTIN_TOOLS
	const builtins: AgentTool<any>[] = [
		withDescription(createBashTool(config.workspacePath), BASH_DESCRIPTION),
		withDescription(createReadTool(config.workspacePath), READ_DESCRIPTION),
		withDescription(createWriteTool(config.workspacePath), WRITE_DESCRIPTION),
		withDescription(createEditTool(config.workspacePath), EDIT_DESCRIPTION),
		createCronTool(config),
		createTtsTool(config, mediaSink),
		...(config.imageGen.enabled
			? [createImageGenTool(config, mediaSink, { referenceAttachments: ctx.referenceAttachments })]
			: []),
		createSendFileTool(config, mediaSink),
		...createWebTools(),
		...createBrowserTools(config, mediaSink),
		...ctx.memory.memoryTools(),
	];
	const reach = (name: string) => toolReach(config, paused, name);
	const direct = [...builtins.filter((tool) => reach(tool.name) === "pinned"), ...mcp.tools("direct")];
	const loadable = builtins.filter((tool) => reach(tool.name) === "loadable");
	const codemode = createCodemodeTool([...builtins.filter((tool) => reach(tool.name) !== "off"), ...mcpTools(mcp)], {
		direct: new Set(direct.map((tool) => tool.name)),
		// pi's deferred exposures: callable from scripts, never listed with a declaration
		deferred: new Set(
			[...loadable, ...mcp.tools("codemode-deferred"), ...mcp.tools("deferred")].map((tool) => tool.name),
		),
		namespaceOf: (name) => mcp.namespaceOf(name),
	});
	const codemodeReach = reach(codemode.name);
	if (codemodeReach === "pinned") direct.push(codemode);
	if (codemodeReach === "loadable") loadable.push(codemode);
	const searchable = [...loadable, ...mcpTools(mcp, true)];
	// tool_search earns its place when something waits on it that a pinned codemode can't reach for
	const needsSearch =
		loadable.length > 0 || mcp.tools("deferred").length > 0 || (codemodeReach !== "pinned" && searchable.length > 0);
	return needsSearch ? [...direct, ...searchableFor(searchable, mcp, ctx.agent)] : direct;
}

/** with skipDirect, what tool_search reaches: like pi, every mcp tool that isn't declared up front */
function mcpTools(mcp: McpHub, skipDirect = false): AgentTool<any>[] {
	return MCP_EXPOSURES.filter((exposure) => !skipDirect || exposure !== "direct").flatMap((exposure) =>
		mcp.tools(exposure),
	);
}

/** every tool that waits for tool_search, so LCM can let a loaded one go again */
export function deferredToolNames(config: Config, mcp: McpHub, paused: ReadonlySet<string>): Set<string> {
	return new Set([
		...BUILTIN_TOOLS.filter((name) => toolReach(config, paused, name) === "loadable"),
		...mcpTools(mcp, true).map((tool) => tool.name),
	]);
}

// searchable tools stay out of state.tools until tool_search finds them; the transcript's system
// messages record what's been loaded, so restarts and reloads rebuild it.
function searchableFor(searchable: AgentTool<any>[], mcp: McpHub, agent: () => Agent): AgentTool<any>[] {
	const loaded = loadedToolNames(agent().state.messages);
	return [
		createToolSearchTool(
			searchable,
			(name) => mcp.namespaceOf(name),
			() => new Set(agent().state.tools.map((tool) => tool.name)),
			(tools) => {
				const current = agent().state.tools;
				const present = new Set(current.map((tool) => tool.name));
				agent().state.tools = [...current, ...tools.filter((tool) => !present.has(tool.name))];
			},
		),
		...searchable.filter((tool) => loaded.has(tool.name)),
	];
}

export function setReferenceAttachments(
	session: FamiliarAgentSession,
	attachments: readonly StoredAttachment[] = [],
): void {
	session.referenceAttachments.splice(0, session.referenceAttachments.length, ...attachments);
}
