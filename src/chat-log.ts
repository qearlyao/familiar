import { appendFile, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { Config } from "./config.js";

export type ChatService = "discord" | "web";
export type ChatScope = "dm" | "channel" | "thread" | "web";
export type ControlCommand = "stop" | "status" | "new" | "compact" | "model" | "thinking" | "channel-trigger";
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
	event: "armed" | "reset" | "stopped";
	detail?: string;
}

export interface ErrorChatRecord extends ChatRecordBase {
	type: "error";
	message: string;
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
	| ErrorChatRecord;

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

function isChatLogRecord(value: unknown): value is ChatLogRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.recordId === "number" && typeof record.ts === "string" && typeof record.type === "string";
}

export function createChatLog(config: Config, channel: ChatChannelRef): ChatLog {
	const dir = chatChannelDir(config, channel);
	const lockPath = chatLockPath(config, channel);
	return {
		channel,
		dir,
		lockPath,
		async read(): Promise<ChatLogRecord[]> {
			let files: string[];
			try {
				files = await readdir(dir);
			} catch (error) {
				if (getErrorCode(error) === "ENOENT") return [];
				throw error;
			}
			const records: ChatLogRecord[] = [];
			for (const file of files.filter((entry) => entry.endsWith(".jsonl")).sort()) {
				const filePath = resolve(dir, file);
				const content = await readFile(filePath, "utf8");
				for (const [index, line] of content.split(/\r?\n/).entries()) {
					if (!line.trim()) continue;
					const parsed = JSON.parse(line) as unknown;
					if (!isChatLogRecord(parsed)) throw new Error(`Malformed chat log record: ${filePath}:${index + 1}`);
					records.push(parsed);
				}
			}
			return records.sort((a, b) => a.recordId - b.recordId);
		},
		async append(record: ChatLogRecord): Promise<void> {
			const recordPath = chatLogPath(config, channel, new Date(record.ts));
			await mkdir(dirname(recordPath), { recursive: true });
			await appendFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");
		},
		async acquire(owner: string): Promise<void> {
			await mkdir(dirname(lockPath), { recursive: true });
			try {
				const handle = await open(lockPath, "wx");
				try {
					await handle.writeFile(`${owner}\n`, "utf8");
				} finally {
					await handle.close();
				}
				return;
			} catch (error) {
				if (getErrorCode(error) !== "EEXIST") throw error;
			}
			const existingOwner = (await readFile(lockPath, "utf8").catch(() => "")).trim();
			const existingPid = extractOwnerPid(existingOwner);
			if (existingPid !== undefined && !isPidAlive(existingPid)) {
				await rm(lockPath, { force: true });
				const handle = await open(lockPath, "wx");
				try {
					await handle.writeFile(`${owner}\n`, "utf8");
				} finally {
					await handle.close();
				}
				return;
			}
			throw new Error(`Chat channel is already locked by ${existingOwner || "another familiar process"}`);
		},
		async release(): Promise<void> {
			await rm(lockPath, { force: true });
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
