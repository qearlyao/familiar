import { resolve } from "node:path";

import type { Config } from "../config/index.js";
import { removeOldFiles } from "../util/fs.js";

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
