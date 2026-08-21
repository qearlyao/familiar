import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Config } from "../config/index.js";
import type { StoredAttachment } from "../conversation/chat-log.js";
import { removeOldFiles } from "../lifecycle/data-retention.js";

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

export function attachmentsDir(config: Config): string {
	return resolve(config.workspace.dataDir, "attachments");
}

export function browserScreenshotsDir(config: Config): string {
	return resolve(config.workspace.dataDir, "attachments", "screenshot");
}

export async function ensureGeneratedAttachmentsDir(config: Config): Promise<string> {
	const dir = generatedAttachmentsDir(config);
	await mkdir(dir, { recursive: true });
	return dir;
}

export async function ensureBrowserScreenshotsDir(config: Config): Promise<string> {
	const dir = browserScreenshotsDir(config);
	await mkdir(dir, { recursive: true });
	return dir;
}

export function cleanupGeneratedAttachments(config: Config, now = Date.now()): Promise<number> {
	return removeOldFiles(attachmentsDir(config), config.media.generatedRetentionDays, now);
}

export function publicAttachmentPath(config: Config, localPath: string): string {
	const absolutePath = resolve(localPath);
	const generatedRelativePath = relative(generatedAttachmentsDir(config), absolutePath);
	if (generatedRelativePath && !generatedRelativePath.startsWith("..") && !isAbsolute(generatedRelativePath)) {
		return `/api/web/attachments/${generatedRelativePath
			.split(/[\\/]+/)
			.map(encodeURIComponent)
			.join("/")}`;
	}
	const screenshotRelativePath = relative(browserScreenshotsDir(config), absolutePath);
	if (screenshotRelativePath && !screenshotRelativePath.startsWith("..") && !isAbsolute(screenshotRelativePath)) {
		return `/api/web/attachments/screenshot/${screenshotRelativePath
			.split(/[\\/]+/)
			.map(encodeURIComponent)
			.join("/")}`;
	}
	const relativePath = relative(attachmentsDir(config), absolutePath);
	if (relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath === "") {
		throw new Error(`Attachment path is outside generated attachments dir: ${localPath}`);
	}
	return `/api/web/attachments/${relativePath
		.split(/[\\/]+/)
		.map(encodeURIComponent)
		.join("/")}`;
}
