import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { createBrowserTools } from "../browser-tools.js";
import type { StoredAttachment } from "../chat-log.js";
import type { Config } from "../config.js";
import type { GeneratedMediaSink } from "../generated-media.js";
import { createImageGenTool } from "../image-gen.js";
import type { MemoryService } from "../memory/service.js";
import { createTtsTool } from "../tts.js";
import { createWebTools } from "../web-tools.js";
import { BASH_DESCRIPTION, EDIT_DESCRIPTION, READ_DESCRIPTION, WRITE_DESCRIPTION } from "./tool-descriptions.js";
import type { FamiliarAgentSession } from "./types.js";

export function createFamiliarTools(
	config: Config,
	mediaSink: GeneratedMediaSink,
	referenceAttachments: () => readonly StoredAttachment[] = () => [],
	memoryService?: MemoryService,
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
		...createWebTools(config),
		...createBrowserTools(config, mediaSink),
		...(memoryService?.memoryTools() ?? []),
	];
}

export function setReferenceAttachments(
	session: FamiliarAgentSession,
	attachments: readonly StoredAttachment[] = [],
): void {
	session.referenceAttachments.splice(0, session.referenceAttachments.length, ...attachments);
}
