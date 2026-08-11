import { appendFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import lockfile from "proper-lockfile";

import type { Config } from "../config/index.js";
import { isEnoent, readFileOrNull } from "../util/fs.js";
import type { ControlCommand } from "./control-commands.js";

export type ChatService = "discord" | "web";
export type ChatScope = "dm" | "channel" | "thread" | "web";
export type { ControlCommand } from "./control-commands.js";
export type JobTrigger = "dm" | "mention" | "message";

export interface ChatChannelRef {
	service: ChatService;
	scope: ChatScope;
	channelId: string;
	channelName?: string;
	threadId?: string;
}

export interface StoredAttachment {
	id: string;
	name: string;
	kind?: "image" | "file" | "audio" | "video";
	mimeType?: string;
	size?: number;
	remoteUrl?: string;
	localPath?: string;
	source?: "discord" | "web" | "generated";
	sourceUrl?: string;
	sha256?: string;
	derived?: {
		text?: {
			provider: string;
			model: string;
			text: string;
			label?: string;
		};
		image?: {
			localPath?: string;
			mimeType: string;
			size: number;
			width?: number;
			height?: number;
			note?: string;
		};
	};
}

interface ChatRecordBase {
	recordId: number;
	ts: string;
	service: ChatService;
	scope: ChatScope;
	channelId: string;
	channelName?: string;
	threadId?: string;
}

export interface InboundChatRecord extends ChatRecordBase {
	type: "inbound";
	messageId: string;
	authorId: string;
	authorName?: string;
	text: string;
	bookId?: string;
	isBot: boolean;
	mentionedBot: boolean;
	attachments: StoredAttachment[];
}

export interface ControlChatRecord extends ChatRecordBase {
	type: "control";
	command: ControlCommand;
	args?: string;
	messageId?: string;
	authorId: string;
	authorName?: string;
	text: string;
}

export interface JobQueuedChatRecord extends ChatRecordBase {
	type: "job_queued";
	jobId: string;
	trigger: JobTrigger;
	triggerRecordId: number;
}

export interface OutboundChatRecord extends ChatRecordBase {
	type: "outbound";
	messageIds: string[];
	webMessageId?: string;
	text: string;
	attachments?: StoredAttachment[];
	thinking?: string;
	thinkingMs?: number;
	silent?: boolean;
	replyToMessageId?: string;
	jobId?: string;
	control?: ControlCommand;
}

export interface JobCompletedChatRecord extends ChatRecordBase {
	type: "job_completed";
	jobId: string;
	triggerRecordId: number;
	outboundRecordId?: number;
}

export interface JobFailedChatRecord extends ChatRecordBase {
	type: "job_failed";
	jobId: string;
	triggerRecordId: number;
	error: string;
}

export type StoredAssistantMessageEvent =
	| { type: "text_delta"; delta: string }
	| { type: "thinking_delta"; delta: string }
	| { type: "toolcall_start"; contentIndex: number }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: { id: string; name: string; arguments: Record<string, unknown> };
	  };

export type StoredAgentEvent =
	| { type: "message_start"; role: "user" | "assistant" | "toolResult" | string }
	| { type: "message_update"; assistantMessageEvent: StoredAssistantMessageEvent }
	| {
			type: "message_end";
			role: "user" | "assistant" | "toolResult" | string;
			stopReason?: string;
			errorMessage?: string;
			usage?: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				cost: number;
			};
	  }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "agent_start" }
	| { type: "agent_end" };

export interface AgentEventChatRecord extends ChatRecordBase {
	type: "agent_event";
	jobId: string;
	messageId: string;
	event: StoredAgentEvent;
}

export interface CheckpointChatRecord extends ChatRecordBase {
	type: "checkpoint";
	cursor?: string;
	messageId?: string;
}

export interface RuntimeChatRecord extends ChatRecordBase {
	type: "runtime";
	event: "armed" | "reset" | "stopped" | "heartbeat" | "heartbeat_failed";
	detail?: string;
}

export interface ErrorChatRecord extends ChatRecordBase {
	type: "error";
	message: string;
}

export interface AssistantRetryChatRecord extends ChatRecordBase {
	type: "assistant_retry";
	oldMessageId: string;
	newMessageId: string;
	jobId: string;
	triggerRecordId: number;
}

export interface MessageDeleteChatRecord extends ChatRecordBase {
	type: "message_delete";
	messageId: string;
}

export interface MessageEditChatRecord extends ChatRecordBase {
	type: "message_edit";
	messageId: string;
	text: string;
}

export type ChatLogRecord =
	| InboundChatRecord
	| ControlChatRecord
	| JobQueuedChatRecord
	| OutboundChatRecord
	| JobCompletedChatRecord
	| JobFailedChatRecord
	| AgentEventChatRecord
	| CheckpointChatRecord
	| RuntimeChatRecord
	| ErrorChatRecord
	| AssistantRetryChatRecord
	| MessageDeleteChatRecord
	| MessageEditChatRecord;

export function hiddenWebMessageIds(records: readonly ChatLogRecord[]): Set<string> {
	return new Set(
		records.flatMap((record) => {
			if (record.type === "assistant_retry") return [record.oldMessageId];
			if (record.type === "message_delete") return [record.messageId];
			return [];
		}),
	);
}

export interface ChatLog {
	channel: ChatChannelRef;
	dir: string;
	lockPath: string;
	read(): Promise<ChatLogRecord[]>;
	append(record: ChatLogRecord): Promise<void>;
	acquire(owner: string): Promise<void>;
	release(): Promise<void>;
}

function sanitizeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._=-]+/g, "_").slice(0, 120) || "unknown";
}

export function chatChannelKey(channel: ChatChannelRef): string {
	const parts = [channel.service, channel.scope, channel.channelId];
	if (channel.threadId) parts.push(channel.threadId);
	return parts.map(sanitizeSegment).join("-");
}

export function chatLogPath(config: Config, channel: ChatChannelRef, now = new Date()): string {
	const date = now.toISOString().slice(0, 10);
	return resolve(config.workspace.dataDir, "chat", chatChannelKey(channel), `${date}.jsonl`);
}

function chatLockPath(config: Config, channel: ChatChannelRef): string {
	return resolve(config.workspace.dataDir, "chat", chatChannelKey(channel), ".lock");
}

function chatChannelDir(config: Config, channel: ChatChannelRef): string {
	return resolve(config.workspace.dataDir, "chat", chatChannelKey(channel));
}

function getErrorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : undefined;
}

function extractOwnerPid(owner: string): number | undefined {
	const match = owner.match(/^familiar-(\d+)-/);
	if (!match) return undefined;
	const pid = Number(match[1]);
	return Number.isFinite(pid) ? pid : undefined;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return getErrorCode(error) === "EPERM";
	}
}

// v0.8.1 wrote a plain file here; proper-lockfile needs the path free for its lock directory.
// ponytail: migration-only — delete this plus extractOwnerPid/isPidAlive once every deploy has booted on 0.8.2+.
async function clearLegacyLock(lockPath: string): Promise<void> {
	const existing = await lstat(lockPath).catch((error: unknown) => {
		if (isEnoent(error)) return null;
		throw error;
	});
	if (!existing || existing.isDirectory()) return;
	if (!existing.isFile()) throw new Error(`Chat channel lock path is neither a lock file nor a lock dir: ${lockPath}`);
	const existingOwner = (await readFileOrNull(lockPath, "utf8"))?.trim() ?? "";
	const existingPid = extractOwnerPid(existingOwner);
	if (existingPid !== undefined && isPidAlive(existingPid)) {
		throw new Error(`Chat channel is already locked by ${existingOwner}`);
	}
	await rm(lockPath, { force: true });
}

function isChatLogRecord(value: unknown): value is ChatLogRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.recordId === "number" && typeof record.ts === "string" && typeof record.type === "string";
}

export function createChatLog(config: Config, channel: ChatChannelRef): ChatLog {
	const dir = chatChannelDir(config, channel);
	const lockPath = chatLockPath(config, channel);
	const ownerPath = `${lockPath}.owner`;
	const staleMs = 30_000;
	let releaseLock: (() => Promise<void>) | undefined;
	let appendTail: Promise<void> = Promise.resolve();
	return {
		channel,
		dir,
		lockPath,
		async read(): Promise<ChatLogRecord[]> {
			let files: string[];
			try {
				files = await readdir(dir);
			} catch (error) {
				if (isEnoent(error)) return [];
				throw error;
			}
			const jsonlFiles = files.filter((entry) => entry.endsWith(".jsonl")).sort();
			const contents = await Promise.all(
				jsonlFiles.map(async (file) => {
					const filePath = resolve(dir, file);
					return { filePath, content: await readFile(filePath, "utf8") };
				}),
			);
			const records: ChatLogRecord[] = [];
			for (const { filePath, content } of contents) {
				for (const [index, line] of content.split(/\r?\n/).entries()) {
					if (!line.trim()) continue;
					const parsed = JSON.parse(line) as unknown;
					if (!isChatLogRecord(parsed)) throw new Error(`Malformed chat log record: ${filePath}:${index + 1}`);
					records.push(parsed);
				}
			}
			return records.sort((a, b) => a.recordId - b.recordId);
		},
		append(record: ChatLogRecord): Promise<void> {
			// appendFile can split large writes, allowing concurrent calls to interleave and corrupt the JSONL stream.
			const operation = appendTail.then(async () => {
				const recordPath = chatLogPath(config, channel, new Date(record.ts));
				await mkdir(dirname(recordPath), { recursive: true });
				await appendFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");
			});
			// Return the original promise so callers see failures, but keep later appends from inheriting the rejection.
			appendTail = operation.catch(() => undefined);
			return operation;
		},
		async acquire(owner: string): Promise<void> {
			await mkdir(dir, { recursive: true });
			await clearLegacyLock(lockPath);
			let acquiredRelease: (() => Promise<void>) | undefined;
			try {
				acquiredRelease = await lockfile.lock(dir, {
					realpath: false,
					lockfilePath: lockPath,
					retries: 0,
					stale: staleMs,
					update: staleMs / 2,
					// The lease heartbeat lost the lock (blocked event loop, disk stall). Drop our claim quietly;
					// the default handler rethrows from a timer callback and takes the whole process down.
					onCompromised: (error) => {
						releaseLock = undefined;
						console.error(`chat lease compromised for ${lockPath}`, error);
					},
				});
				await writeFile(ownerPath, `${owner}\n`, "utf8");
				releaseLock = acquiredRelease;
			} catch (error) {
				if (acquiredRelease) {
					await acquiredRelease();
					throw error;
				}
				if (getErrorCode(error) !== "ELOCKED") throw error;
				const existingOwner = (await readFileOrNull(ownerPath, "utf8"))?.trim() ?? "";
				throw new Error(`Chat channel is already locked by ${existingOwner || "another familiar process"}`);
			}
		},
		async release(): Promise<void> {
			const release = releaseLock;
			releaseLock = undefined;
			if (!release) return;
			// Drop the owner marker while we still hold the lock, or we race the next holder's write.
			await rm(ownerPath, { force: true });
			try {
				await release();
			} catch (error) {
				const code = getErrorCode(error);
				if (code !== "ERELEASED" && code !== "ENOTACQUIRED") throw error;
			}
		},
	};
}

export function buildRecordBase(channel: ChatChannelRef, recordId: number): ChatRecordBase {
	return {
		recordId,
		ts: new Date().toISOString(),
		service: channel.service,
		scope: channel.scope,
		channelId: channel.channelId,
		channelName: channel.channelName,
		threadId: channel.threadId,
	};
}
