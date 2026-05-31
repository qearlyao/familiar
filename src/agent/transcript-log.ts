import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Config } from "../config.js";
import { isEnoent } from "../util/fs.js";

function dailyLogPath(dataDir: string, streamName: "payloads" | "transcripts", now = new Date()): string {
	const date = now.toISOString().slice(0, 10);
	return resolve(dataDir, streamName, `${date}.jsonl`);
}

async function appendJsonl(path: string, record: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export function writePayloadLog(config: Config, record: Record<string, unknown>): void {
	appendJsonl(dailyLogPath(config.workspace.dataDir, "payloads"), record).catch((err) =>
		console.error("payload log write failed", err),
	);
}

export function writeTranscriptLog(config: Config, record: Record<string, unknown>): void {
	appendJsonl(dailyLogPath(config.workspace.dataDir, "transcripts"), record).catch((err) =>
		console.error("transcript log write failed", err),
	);
}

type StoredMessageRecord = {
	ts: string;
	sessionId: string;
	message: AgentMessage;
};

type StoredResetRecord = {
	ts: string;
	sessionId: string;
	type: "reset";
};

type StoredTranscriptRecord = StoredMessageRecord | StoredResetRecord;

function isStoredMessageRecord(value: unknown): value is StoredMessageRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.ts === "string" && typeof record.sessionId === "string" && !!record.message;
}

function isStoredResetRecord(value: unknown): value is StoredResetRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.type === "reset" && typeof record.ts === "string" && typeof record.sessionId === "string";
}

export async function loadStoredMessages(dataDir: string, sessionId: string): Promise<AgentMessage[]> {
	const transcriptsDir = resolve(dataDir, "transcripts");
	let files: string[];
	try {
		files = await readdir(transcriptsDir);
	} catch (error) {
		if (isEnoent(error)) return [];
		console.error("transcript history read failed", error);
		return [];
	}

	const jsonlFiles = files.filter((entry) => entry.endsWith(".jsonl")).sort();
	const reads = await Promise.all(
		jsonlFiles.map(async (file) => {
			const path = resolve(transcriptsDir, file);
			try {
				return { path, contents: await readFile(path, "utf8") };
			} catch (error) {
				console.error(`transcript file read failed: ${path}`, error);
				return undefined;
			}
		}),
	);

	const records: StoredTranscriptRecord[] = [];
	for (const read of reads) {
		if (!read) continue;
		const { path, contents } = read;
		for (const [index, line] of contents.split(/\r?\n/).entries()) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as unknown;
				if (!isStoredMessageRecord(parsed) && !isStoredResetRecord(parsed)) {
					console.error(`skipping malformed transcript line: ${path}:${index + 1}`);
					continue;
				}
				if (parsed.sessionId !== sessionId) continue;
				records.push(parsed);
			} catch (error) {
				console.error(`skipping unparsable transcript line: ${path}:${index + 1}`, error);
			}
		}
	}

	records.sort((a, b) => a.ts.localeCompare(b.ts));
	let lastResetIndex = -1;
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index];
		if (record && "type" in record && record.type === "reset") {
			lastResetIndex = index;
			break;
		}
	}
	const activeRecords = lastResetIndex >= 0 ? records.slice(lastResetIndex + 1) : records;
	return activeRecords.flatMap((record) => ("message" in record ? [record.message] : []));
}
