import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config/index.js";
import type { StoredAttachment } from "../conversation/chat-log.js";
import type { GeneratedMediaSink } from "../media/generated-media.js";
import { createImageGenTool } from "../media/image-gen.js";
import { createTtsTool } from "../media/tts.js";
import type { MemoryService } from "../memory/service.js";
import { createBrowserTools } from "../tools/browser-tools.js";
import { createLoadToolsTool, loadedToolNames, type McpHub } from "../tools/mcp.js";
import { createWebTools } from "../web-tools/index.js";
import { BASH_DESCRIPTION, EDIT_DESCRIPTION, READ_DESCRIPTION, WRITE_DESCRIPTION } from "./tool-descriptions.js";
import type { FamiliarAgentSession } from "./types.js";

export function createFamiliarTools(
	config: Config,
	mediaSink: GeneratedMediaSink,
	referenceAttachments: () => readonly StoredAttachment[] = () => [],
	memoryService: MemoryService | undefined,
	mcp: McpHub,
	agent: () => Agent,
): AgentTool<any>[] {
	const bashTool = createBashTool(config.workspacePath);
	bashTool.description = BASH_DESCRIPTION;
	const readTool = createReadTool(config.workspacePath);
	readTool.description = READ_DESCRIPTION;
	const writeTool = createWriteTool(config.workspacePath);
	writeTool.description = WRITE_DESCRIPTION;
	const editTool = createEditTool(config.workspacePath);
	editTool.description = EDIT_DESCRIPTION;
	return [
		bashTool,
		readTool,
		writeTool,
		editTool,
		createTtsTool(config, mediaSink),
		...(config.imageGen.enabled ? [createImageGenTool(config, mediaSink, { referenceAttachments })] : []),
		...createWebTools(),
		...createBrowserTools(config, mediaSink),
		...(memoryService?.memoryTools() ?? []),
		...mcp.tools,
		...deferredToolsFor(mcp, agent),
	];
}

// deferred tools stay out of state.tools until load_tools names them; the transcript's
// addedToolNames is the record of what's been loaded, so restarts and reloads rebuild it.
function deferredToolsFor(mcp: McpHub, agent: () => Agent): AgentTool<any>[] {
	if (mcp.deferred.length === 0) return [];
	const loaded = loadedToolNames(agent().state.messages);
	return [
		createLoadToolsTool(mcp.deferred, (tools) => {
			const current = agent().state.tools;
			const present = new Set(current.map((tool) => tool.name));
			agent().state.tools = [...current, ...tools.filter((tool) => !present.has(tool.name))];
		}),
		...mcp.deferred.filter((tool) => loaded.has(tool.name)),
	];
}

export function setReferenceAttachments(
	session: FamiliarAgentSession,
	attachments: readonly StoredAttachment[] = [],
): void {
	session.referenceAttachments.splice(0, session.referenceAttachments.length, ...attachments);
}
