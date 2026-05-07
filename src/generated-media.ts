import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { StoredAttachment } from "./chat-log.js";
import type { Config } from "./config.js";

export interface GeneratedAttachment extends StoredAttachment {
	provider?: string;
	toolName?: string;
}

export interface GeneratedMediaSink {
	add(attachment: GeneratedAttachment): void;
	drain(): GeneratedAttachment[];
}

export function createGeneratedMediaSink(): GeneratedMediaSink {
	const attachments: GeneratedAttachment[] = [];
	return {
		add(attachment: GeneratedAttachment): void {
			attachments.push(attachment);
		},
		drain(): GeneratedAttachment[] {
			return attachments.splice(0);
		},
	};
}

export function generatedAttachmentsDir(config: Config): string {
	return resolve(config.workspace.dataDir, "attachments", "generated");
}

export async function ensureGeneratedAttachmentsDir(config: Config): Promise<string> {
	const dir = generatedAttachmentsDir(config);
	await mkdir(dir, { recursive: true });
	return dir;
}

export function publicAttachmentPath(config: Config, localPath: string): string {
	const absolutePath = resolve(localPath);
	const relativePath = relative(generatedAttachmentsDir(config), absolutePath);
	if (relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath === "") {
		throw new Error(`Generated attachment path is outside generated attachments dir: ${localPath}`);
	}
	return `/api/web/attachments/${relativePath
		.split(/[\\/]+/)
		.map(encodeURIComponent)
		.join("/")}`;
}
