import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

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

export async function cleanupGeneratedAttachments(config: Config, now = Date.now()): Promise<number> {
	const retentionDays = config.media.generatedRetentionDays;
	if (retentionDays <= 0) return 0;
	const dir = generatedAttachmentsDir(config);
	const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return 0;
		throw error;
	}
	let removed = 0;
	for (const entry of entries) {
		const path = join(dir, entry);
		const fileStat = await lstat(path).catch(() => undefined);
		if (!fileStat?.isFile() || fileStat.mtimeMs > cutoff) continue;
		await rm(path).catch((error) => {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
		});
		removed++;
	}
	return removed;
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
