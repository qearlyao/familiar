import type { Dirent } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Config } from "./config.js";
import { isEnoent } from "./util/fs.js";

export interface DataRetentionReport {
	chat: number;
	transcripts: number;
	payloads: number;
}

export async function runDataRetention(config: Config, now = Date.now()): Promise<DataRetentionReport> {
	if (config.data.transcripts.retentionDays > 0) {
		console.warn(
			"data.transcripts.retention_days is configured; transcript replay may lose restart context after retention.",
		);
	}
	return {
		chat: await removeOldFiles(resolve(config.workspace.dataDir, "chat"), config.data.chat.retentionDays, now),
		transcripts: await removeOldFiles(
			resolve(config.workspace.dataDir, "transcripts"),
			config.data.transcripts.retentionDays,
			now,
		),
		payloads: await removeOldFiles(
			resolve(config.workspace.dataDir, "payloads"),
			config.data.payloads.retentionDays,
			now,
		),
	};
}

async function removeOldFiles(root: string, retentionDays: number, now: number): Promise<number> {
	if (retentionDays <= 0) return 0;
	const cutoff = now - retentionDays * 86_400_000;
	let removed = 0;
	for (const path of await listFiles(root)) {
		const fileStat = await lstat(path).catch((error) => {
			if (isEnoent(error)) return null;
			throw error;
		});
		if (!fileStat?.isFile() || fileStat.mtimeMs > cutoff) continue;
		await rm(path).catch((error) => {
			if (!isEnoent(error)) throw error;
		});
		removed += 1;
	}
	return removed;
}

async function listFiles(root: string): Promise<string[]> {
	let entries: Dirent<string>[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = join(root, entry.name);
			if (entry.isDirectory()) return listFiles(path);
			return entry.isFile() ? [path] : [];
		}),
	);
	return nested.flat();
}
