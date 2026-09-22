import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOLS } from "../config/enums.js";
import type { Config, ToolReach } from "../config/index.js";
import type { StoredAttachment } from "../conversation/chat-log.js";
import type { GeneratedMediaSink } from "../media/generated-media.js";
import { createImageGenTool } from "../media/image-gen.js";
import { createTtsTool } from "../media/tts.js";
import type { MemoryService } from "../memory/service.js";
import { createBrowserTools } from "../tools/browser-tools.js";
import { createCronTool } from "../tools/cron.js";
import { createLoadToolsTool, loadedToolNames, type McpHub } from "../tools/mcp.js";
import { createWebTools } from "../web-tools/index.js";
import { BASH_DESCRIPTION, EDIT_DESCRIPTION, READ_DESCRIPTION, WRITE_DESCRIPTION } from "./tool-descriptions.js";
import type { FamiliarAgentSession } from "./types.js";

/** a paused tool is off until the next restart, whatever its lasting reach says */
export function toolReach(config: Config, paused: ReadonlySet<string>, name: string): ToolReach {
	return paused.has(name) ? "off" : (config.tools.reach[name] ?? "pinned");
}

export function createFamiliarTools(
	config: Config,
	mediaSink: GeneratedMediaSink,
	referenceAttachments: () => readonly StoredAttachment[] = () => [],
	memoryService: MemoryService | undefined,
	mcp: McpHub,
	agent: () => Agent,
	paused: ReadonlySet<string> = new Set(),
): AgentTool<any>[] {
	const bashTool = createBashTool(config.workspacePath);
	bashTool.description = BASH_DESCRIPTION;
	const readTool = createReadTool(config.workspacePath);
	readTool.description = READ_DESCRIPTION;
	const writeTool = createWriteTool(config.workspacePath);
	writeTool.description = WRITE_DESCRIPTION;
	const editTool = createEditTool(config.workspacePath);
	editTool.description = EDIT_DESCRIPTION;
	const builtins: AgentTool<any>[] = [
		bashTool,
		readTool,
		writeTool,
		editTool,
		createCronTool(config),
		createTtsTool(config, mediaSink),
		...(config.imageGen.enabled ? [createImageGenTool(config, mediaSink, { referenceAttachments })] : []),
		...createWebTools(),
		...createBrowserTools(config, mediaSink),
		...(memoryService?.memoryTools() ?? []),
	];
	const pinned = builtins.filter((tool) => toolReach(config, paused, tool.name) === "pinned");
	const loadable = builtins.filter((tool) => toolReach(config, paused, tool.name) === "loadable");
	return [...pinned, ...mcp.tools, ...deferredToolsFor([...loadable, ...mcp.deferred], agent)];
}

/** every tool that waits for load_tools: loadable built-ins and deferred mcp servers */
export function deferredToolNames(config: Config, mcp: McpHub, paused: ReadonlySet<string>): Set<string> {
	return new Set([
		...BUILTIN_TOOLS.filter((name) => toolReach(config, paused, name) === "loadable"),
		...mcp.deferred.map((tool) => tool.name),
	]);
}

// deferred tools stay out of state.tools until load_tools names them; the transcript's system
// messages record what's been loaded, so restarts and reloads rebuild it.
function deferredToolsFor(deferred: AgentTool<any>[], agent: () => Agent): AgentTool<any>[] {
	if (deferred.length === 0) return [];
	const loaded = loadedToolNames(agent().state.messages);
	return [
		createLoadToolsTool(deferred, (tools) => {
			const current = agent().state.tools;
			const present = new Set(current.map((tool) => tool.name));
			agent().state.tools = [...current, ...tools.filter((tool) => !present.has(tool.name))];
		}),
		...deferred.filter((tool) => loaded.has(tool.name)),
	];
}

export function setReferenceAttachments(
	session: FamiliarAgentSession,
	attachments: readonly StoredAttachment[] = [],
): void {
	session.referenceAttachments.splice(0, session.referenceAttachments.length, ...attachments);
}
