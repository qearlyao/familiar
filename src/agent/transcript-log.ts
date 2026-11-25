import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Config } from "../config/index.js";
import { isEnoent } from "../util/fs.js";

function dailyLogPath(dataDir: string, streamName: "payloads" | "transcripts", now = new Date()): string {
	const date = now.toISOString().slice(0, 10);
	return resolve(dataDir, streamName, `${date}.jsonl`);
}

type JsonReplacer = (key: string, value: unknown) => unknown;

async function appendJsonl(path: string, record: unknown, replacer?: JsonReplacer): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(record, replacer)}\n`, "utf8");
}

const BASE64_MIN_LENGTH = 1024;
const BASE64_BODY = /^[A-Za-z0-9+/_-]+={0,2}$/;
const BASE64_DATA_URL_PREFIX = /^data:[^;,]+;base64,/;

/** a payload carries every image still in context, re-sent on every request; the log keeps a
    fingerprint so diffs still see a changed image, without writing megabytes of it each time */
function elideBase64(_key: string, value: unknown): unknown {
	if (typeof value !== "string" || value.length < BASE64_MIN_LENGTH) return value;
	const prefix = BASE64_DATA_URL_PREFIX.exec(value)?.[0] ?? "";
	const body = value.slice(prefix.length);
	if (!BASE64_BODY.test(body)) return value;
	const bytes = Math.floor((body.replace(/=+$/, "").length * 3) / 4);
	const digest = createHash("sha256").update(body).digest("hex").slice(0, 12);
	return `${prefix}[base64 ${bytes} bytes sha256:${digest}]`;
}

// one record serialized at a time, so a burst of tool-loop requests never holds several
// serialized contexts in memory at once
let payloadWrites: Promise<void> = Promise.resolve();

export function writePayloadLog(config: Config, record: Record<string, unknown>): void {
	const path = dailyLogPath(config.workspace.dataDir, "payloads");
	payloadWrites = payloadWrites
		.then(() => appendJsonl(path, record, elideBase64))
		.catch((err) => console.error("payload log write failed", err));
}

/** settles once every payload record queued so far is on disk */
export function flushPayloadLog(): Promise<void> {
	return payloadWrites;
}

export function writeTranscriptLog(config: Config, record: Record<string, unknown>): void {
	appendJsonl(dailyLogPath(config.workspace.dataDir, "transcripts"), record).catch((err) =>
		console.error("transcript log write failed", err),
	);
}

export async function writeTranscriptReset(config: Config, sessionId: string): Promise<void> {
	await appendJsonl(dailyLogPath(config.workspace.dataDir, "transcripts"), {
		ts: new Date().toISOString(),
		sessionId,
		type: "reset",
	});
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

type StoredSupersedeRecord = {
	ts: string;
	sessionId: string;
	type: "supersede";
	messageTimestamp: number;
};

type StoredTranscriptRecord = StoredMessageRecord | StoredResetRecord | StoredSupersedeRecord;

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

function isStoredSupersedeRecord(value: unknown): value is StoredSupersedeRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		record.type === "supersede" &&
		typeof record.ts === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.messageTimestamp === "number"
	);
}

/** the session's messages since its last reset; `skip` drops messages as they are read, so
    history a summary already covers never piles up in memory */
export async function loadStoredMessages(
	dataDir: string,
	sessionId: string,
	skip: (message: AgentMessage) => boolean = () => false,
): Promise<AgentMessage[]> {
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
	let records: StoredTranscriptRecord[] = [];
	for (const file of jsonlFiles) {
		const path = resolve(transcriptsDir, file);
		let index = 0;
		try {
			for await (const line of createInterface({
				input: createReadStream(path),
				crlfDelay: Number.POSITIVE_INFINITY,
			})) {
				index += 1;
				// other sessions share these files; skip their lines without parsing them
				if (!line.includes(sessionId)) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch (error) {
					console.error(`skipping unparsable transcript line: ${path}:${index}`, error);
					continue;
				}
				if (!isStoredMessageRecord(parsed) && !isStoredResetRecord(parsed) && !isStoredSupersedeRecord(parsed)) {
					console.error(`skipping malformed transcript line: ${path}:${index}`);
					continue;
				}
				if (parsed.sessionId !== sessionId) continue;
				if ("message" in parsed && skip(parsed.message)) continue;
				// everything before a reset is dropped below anyway; don't hold it while reading on
				if ("type" in parsed && parsed.type === "reset") {
					const resetTs = parsed.ts;
					records = records.filter((record) => record.ts > resetTs);
				}
				records.push(parsed);
			}
		} catch (error) {
			console.error(`transcript file read failed: ${path}`, error);
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
	const superseded = new Set(
		activeRecords.flatMap((record) =>
			"type" in record && record.type === "supersede" ? [record.messageTimestamp] : [],
		),
	);
	return activeRecords.flatMap((record) =>
		"message" in record && !superseded.has(record.message.timestamp) ? [record.message] : [],
	);
}
