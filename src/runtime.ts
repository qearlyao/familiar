import { randomUUID } from "node:crypto";

import {
	buildRecordBase,
	type ChatChannelRef,
	type ChatLog,
	type ChatLogRecord,
	type ControlCommand,
	type InboundChatRecord,
	type JobTrigger,
	type StoredAgentEvent,
	type StoredAttachment,
} from "./chat-log.js";
import type { DiscordChannelTrigger } from "./config.js";

export interface InboundMessageInput {
	messageId: string;
	authorId: string;
	authorName?: string;
	text: string;
	isBot?: boolean;
	mentionedBot?: boolean;
	attachments?: InboundChatRecord["attachments"];
	remoteTimestamp?: string;
	checkpoint?: {
		cursor?: string;
		messageId?: string;
	};
}

export interface InboundDispatchOptions {
	mode?: "queue" | "collect";
	channelTrigger?: DiscordChannelTrigger;
}

export interface CollectDispatchOptions {
	channelTrigger?: DiscordChannelTrigger;
}

export interface ParsedControlCommand {
	command: ControlCommand;
	args: string;
}

export interface QueuedJob {
	jobId: string;
	trigger: JobTrigger;
	triggerRecordId: number;
	queuedRecordId: number;
}

export interface DispatchableJob {
	job: QueuedJob;
	prompt: string;
	attachments: StoredAttachment[];
	triggerMessageId?: string;
}

export interface ConversationStatus {
	channelKey: string;
	logDir: string;
	queueLength: number;
	hasActiveJob: boolean;
	recordCount: number;
	lastRecordId: number;
	armed: boolean;
}

export type RuntimeRecordListener = (record: ChatLogRecord) => void | Promise<void>;
export type RuntimeAgentEventListener = (event: {
	jobId: string;
	messageId: string;
	event: StoredAgentEvent;
	ts: number;
}) => void | Promise<void>;

function formatAuthor(authorName: string | undefined, authorId: string): string {
	return authorName ? `${authorName} (uid:${authorId})` : `uid:${authorId}`;
}

function formatPromptRecord(record: InboundChatRecord): string {
	const text = record.text.trim() || "(no text)";
	const author = record.authorName?.trim()
		? `${record.authorName.trim()} uid:${record.authorId}`
		: `uid:${record.authorId}`;
	const attachmentText = record.attachments.length
		? `\n${record.attachments
				.map((attachment) => {
					const derived = attachment.derived?.text?.text ? ` derived:${attachment.derived.text.text}` : "";
					return `[attachment ${attachment.name} id:${attachment.id} kind:${attachment.kind ?? "file"} mime:${attachment.mimeType ?? "unknown"} size:${attachment.size ?? "unknown"}${derived}]`;
				})
				.join("\n")}`
		: "";
	return `[${author} @ ${record.ts}] ${text}${attachmentText}`;
}

function getTriggerRecord(records: ChatLogRecord[], job: QueuedJob): InboundChatRecord | undefined {
	const record = records.find((candidate) => candidate.recordId === job.triggerRecordId);
	return record?.type === "inbound" ? record : undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class ConversationRuntime {
	readonly channel: ChatChannelRef;
	readonly channelKey: string;
	private readonly log: ChatLog;
	private readonly ownerId: string;
	private readonly botUserId?: string;
	private records: ChatLogRecord[] = [];
	private nextRecordId = 1;
	private armedAfterRecordId: number | undefined;
	private pendingJobs: QueuedJob[] = [];
	private activeJob: QueuedJob | undefined;
	private listeners = new Set<RuntimeRecordListener>();
	private agentEventListeners = new Set<RuntimeAgentEventListener>();

	private constructor(options: {
		channelKey: string;
		log: ChatLog;
		ownerId: string;
		botUserId?: string;
	}) {
		this.channel = options.log.channel;
		this.channelKey = options.channelKey;
		this.log = options.log;
		this.ownerId = options.ownerId;
		this.botUserId = options.botUserId;
	}

	static async connect(options: {
		channelKey: string;
		log: ChatLog;
		ownerId: string;
		botUserId?: string;
	}): Promise<ConversationRuntime> {
		const runtime = new ConversationRuntime(options);
		await runtime.initialize();
		return runtime;
	}

	private async initialize(): Promise<void> {
		await this.log.acquire(`familiar-${process.pid}-${this.channelKey}`);
		this.records = await this.log.read();
		this.nextRecordId = this.records.reduce((max, record) => Math.max(max, record.recordId), 0) + 1;
		this.rebuildPendingJobs();
	}

	private rebuildPendingJobs(): void {
		const terminalJobIds = new Set<string>();
		const queuedJobs: QueuedJob[] = [];
		for (const record of this.records) {
			if (record.type === "job_completed" || record.type === "job_failed") terminalJobIds.add(record.jobId);
			if (record.type === "job_queued") {
				queuedJobs.push({
					jobId: record.jobId,
					trigger: record.trigger,
					triggerRecordId: record.triggerRecordId,
					queuedRecordId: record.recordId,
				});
			}
		}
		this.pendingJobs = queuedJobs.filter((job) => !terminalJobIds.has(job.jobId));
	}

	async disconnect(): Promise<void> {
		await this.log.release();
	}

	async armAfterCurrentTail(): Promise<void> {
		this.armedAfterRecordId = this.records.at(-1)?.recordId ?? 0;
		await this.appendRecord({
			type: "runtime",
			...buildRecordBase(this.channel, this.nextRecordId),
			event: "armed",
			detail: `armed after record ${this.armedAfterRecordId}`,
		});
	}

	private async appendRecord(record: ChatLogRecord, options: { notify?: boolean } = {}): Promise<void> {
		this.records.push(record);
		this.nextRecordId = Math.max(this.nextRecordId, record.recordId + 1);
		await this.log.append(record);
		if (options.notify === false) return;
		for (const listener of this.listeners) {
			void Promise.resolve(listener(record)).catch((error) =>
				console.error(`runtime listener failed for ${this.channelKey}`, error),
			);
		}
	}

	subscribe(listener: RuntimeRecordListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	subscribeAgentEvents(listener: RuntimeAgentEventListener): () => void {
		this.agentEventListeners.add(listener);
		return () => {
			this.agentEventListeners.delete(listener);
		};
	}

	publishAgentEvent(jobId: string, messageId: string, event: StoredAgentEvent): void {
		const payload = { jobId, messageId, event, ts: Date.now() };
		for (const listener of this.agentEventListeners) {
			void Promise.resolve(listener(payload)).catch((error) =>
				console.error(`runtime agent event listener failed for ${this.channelKey}`, error),
			);
		}
	}

	private isOwnerMessage(input: Pick<InboundMessageInput, "authorId" | "isBot">): boolean {
		if (input.isBot) return false;
		return input.authorId === this.ownerId;
	}

	private getLastQueuedTriggerRecordId(): number {
		let last = 0;
		for (const record of this.records) {
			if (record.type === "job_queued") last = Math.max(last, record.triggerRecordId);
		}
		return last;
	}

	private getLastCompletedTriggerRecordId(): number {
		let last = 0;
		for (const record of this.records) {
			if (record.type === "job_completed") last = Math.max(last, record.triggerRecordId);
		}
		return last;
	}

	private canRecordTrigger(record: InboundChatRecord, options: InboundDispatchOptions = {}): JobTrigger | undefined {
		if (this.armedAfterRecordId === undefined) return undefined;
		if (record.recordId <= this.armedAfterRecordId) return undefined;
		if (record.recordId <= this.getLastQueuedTriggerRecordId()) return undefined;
		if (this.channel.scope === "dm" || this.channel.scope === "web") {
			if (!this.isOwnerMessage(record)) return undefined;
			return options.mode === "collect" ? undefined : "dm";
		}
		if (options.mode === "collect") return undefined;
		if (options.channelTrigger === "always") return "message";
		return record.mentionedBot ? "mention" : undefined;
	}

	hasActiveJob(jobId?: string): boolean {
		if (!this.activeJob) return false;
		return jobId ? this.activeJob.jobId === jobId : true;
	}

	parseControlCommand(
		input: Pick<InboundMessageInput, "authorId" | "isBot" | "mentionedBot" | "text">,
	): ParsedControlCommand | undefined {
		if (!this.isOwnerMessage(input)) return undefined;
		let text = input.text;
		if (this.botUserId) text = text.replace(new RegExp(`<@!?${escapeRegExp(this.botUserId)}>`, "g"), " ");
		const normalized = text.replace(/\s+/g, " ").trim();
		const commandText = normalized.toLowerCase();
		const slashCommand = commandText.startsWith("/");
		const explicitBotCommand = input.mentionedBot === true;
		if (!slashCommand && !explicitBotCommand) return undefined;
		const [rawCommand = "", ...argParts] = normalized.split(" ");
		const command = rawCommand.replace(/^\//, "").toLowerCase();
		if (!["stop", "status", "new", "compact", "model", "thinking", "channel-trigger"].includes(command)) {
			return undefined;
		}
		return {
			command: command as ControlCommand,
			args: argParts.join(" ").trim(),
		};
	}

	async noteControlCommand(input: InboundMessageInput, control: ParsedControlCommand): Promise<void> {
		await this.appendRecord({
			type: "control",
			...buildRecordBase(this.channel, this.nextRecordId),
			command: control.command,
			args: control.args || undefined,
			messageId: input.messageId,
			authorId: input.authorId,
			authorName: input.authorName,
			text: input.text.trim(),
		});
		if (input.checkpoint) await this.noteCheckpoint(input.checkpoint);
	}

	async ingestInbound(
		input: InboundMessageInput,
		options: InboundDispatchOptions = {},
	): Promise<{ record: InboundChatRecord; jobQueued: boolean }> {
		const record: InboundChatRecord = {
			type: "inbound",
			...buildRecordBase(this.channel, this.nextRecordId),
			ts: input.remoteTimestamp || new Date().toISOString(),
			messageId: input.messageId,
			authorId: input.authorId,
			authorName: input.authorName,
			text: input.text.trim(),
			isBot: input.isBot ?? false,
			mentionedBot: input.mentionedBot ?? false,
			attachments: input.attachments ?? [],
		};
		await this.appendRecord(record);
		if (input.checkpoint) await this.noteCheckpoint(input.checkpoint);
		const trigger = this.canRecordTrigger(record, options);
		if (!trigger) return { record, jobQueued: false };
		await this.queueTrigger(record, trigger);
		return { record, jobQueued: true };
	}

	async queueLatestTrigger(options: CollectDispatchOptions = {}): Promise<QueuedJob | undefined> {
		const record = this.getLatestQueueableInbound(options);
		if (!record) return undefined;
		const trigger =
			this.channel.scope === "dm" || this.channel.scope === "web"
				? "dm"
				: options.channelTrigger === "always"
					? "message"
					: "mention";
		return this.queueTrigger(record, trigger);
	}

	buildSteerPromptForRecord(record: InboundChatRecord): string {
		return formatPromptRecord(record);
	}

	private getLatestQueueableInbound(options: CollectDispatchOptions): InboundChatRecord | undefined {
		const lastQueuedTriggerRecordId = this.getLastQueuedTriggerRecordId();
		let latest: InboundChatRecord | undefined;
		let sawMention = false;
		for (let index = this.records.length - 1; index >= 0; index--) {
			const record = this.records[index];
			if (record?.type !== "inbound") continue;
			if (this.armedAfterRecordId === undefined) return undefined;
			if (record.recordId <= this.armedAfterRecordId || record.recordId <= lastQueuedTriggerRecordId) break;
			if (this.channel.scope === "dm" || this.channel.scope === "web") {
				if (!this.isOwnerMessage(record)) continue;
				return record;
			}
			latest ??= record;
			if (record.mentionedBot) sawMention = true;
		}
		if (options.channelTrigger === "always") return latest;
		return sawMention ? latest : undefined;
	}

	private async queueTrigger(record: InboundChatRecord, trigger: JobTrigger): Promise<QueuedJob> {
		const queuedRecord = {
			type: "job_queued",
			...buildRecordBase(this.channel, this.nextRecordId),
			jobId: randomUUID(),
			trigger,
			triggerRecordId: record.recordId,
		} as const;
		await this.appendRecord(queuedRecord);
		const job = {
			jobId: queuedRecord.jobId,
			trigger: queuedRecord.trigger,
			triggerRecordId: queuedRecord.triggerRecordId,
			queuedRecordId: queuedRecord.recordId,
		};
		this.pendingJobs.push(job);
		return job;
	}

	beginNextJob(): DispatchableJob | undefined {
		if (this.activeJob || this.pendingJobs.length === 0) return undefined;
		const job = this.pendingJobs.shift();
		if (!job) return undefined;
		this.activeJob = job;
		const triggerRecord = getTriggerRecord(this.records, job);
		return {
			job,
			prompt: this.buildPrompt(job),
			attachments: this.buildPromptAttachments(job),
			triggerMessageId: triggerRecord?.messageId,
		};
	}

	private buildPrompt(job: QueuedJob): string {
		const completedBoundary = this.getLastCompletedTriggerRecordId();
		const slice = this.records.filter((record): record is InboundChatRecord => {
			return (
				record.type === "inbound" && record.recordId > completedBoundary && record.recordId <= job.triggerRecordId
			);
		});
		return slice.map(formatPromptRecord).join("\n").trim();
	}

	private buildPromptAttachments(job: QueuedJob): StoredAttachment[] {
		const completedBoundary = this.getLastCompletedTriggerRecordId();
		const slice = this.records.filter((record): record is InboundChatRecord => {
			return (
				record.type === "inbound" && record.recordId > completedBoundary && record.recordId <= job.triggerRecordId
			);
		});
		return slice.flatMap((record) => record.attachments);
	}

	async noteOutbound(options: {
		text: string;
		messageIds: string[];
		webMessageId?: string;
		attachments?: StoredAttachment[];
		thinking?: string;
		thinkingMs?: number;
		silent?: boolean;
		replyToMessageId?: string;
		jobId?: string;
		control?: ControlCommand;
	}): Promise<number | undefined> {
		const text = options.text.trim();
		if (!text && options.messageIds.length === 0) return undefined;
		const record = {
			type: "outbound",
			...buildRecordBase(this.channel, this.nextRecordId),
			messageIds: options.messageIds,
			webMessageId: options.webMessageId,
			text,
			attachments: options.attachments?.length ? options.attachments : undefined,
			thinking: options.thinking,
			thinkingMs: options.thinkingMs,
			silent: options.silent || undefined,
			replyToMessageId: options.replyToMessageId,
			jobId: options.jobId,
			control: options.control,
		} as const;
		await this.appendRecord(record);
		return record.recordId;
	}

	async completeActiveJob(options: {
		text: string;
		messageIds: string[];
		webMessageId?: string;
		attachments?: StoredAttachment[];
		thinking?: string;
		thinkingMs?: number;
		silent?: boolean;
		replyToMessageId?: string;
	}): Promise<void> {
		const job = this.activeJob;
		if (!job) return;
		const outboundRecordId = await this.noteOutbound({
			text: options.text,
			messageIds: options.messageIds,
			webMessageId: options.webMessageId,
			attachments: options.attachments,
			thinking: options.thinking,
			thinkingMs: options.thinkingMs,
			silent: options.silent,
			replyToMessageId: options.replyToMessageId,
			jobId: job.jobId,
		});
		await this.appendRecord({
			type: "job_completed",
			...buildRecordBase(this.channel, this.nextRecordId),
			jobId: job.jobId,
			triggerRecordId: job.triggerRecordId,
			outboundRecordId,
		});
		this.activeJob = undefined;
	}

	async noteAgentEvent(
		jobId: string,
		messageId: string,
		event: StoredAgentEvent,
		options: { notify?: boolean } = {},
	): Promise<void> {
		await this.appendRecord(
			{
				type: "agent_event",
				...buildRecordBase(this.channel, this.nextRecordId),
				jobId,
				messageId,
				event,
			},
			options,
		);
	}

	async failActiveJob(error: string): Promise<void> {
		const job = this.activeJob;
		if (!job) return;
		await this.appendRecord({
			type: "job_failed",
			...buildRecordBase(this.channel, this.nextRecordId),
			jobId: job.jobId,
			triggerRecordId: job.triggerRecordId,
			error,
		});
		this.activeJob = undefined;
	}

	async noteCheckpoint(checkpoint: { cursor?: string; messageId?: string }): Promise<void> {
		const previous = this.getLastCheckpoint();
		if (previous.cursor === checkpoint.cursor && previous.messageId === checkpoint.messageId) return;
		await this.appendRecord({
			type: "checkpoint",
			...buildRecordBase(this.channel, this.nextRecordId),
			cursor: checkpoint.cursor,
			messageId: checkpoint.messageId,
		});
	}

	getLastCheckpoint(): { cursor?: string; messageId?: string } {
		for (let index = this.records.length - 1; index >= 0; index--) {
			const record = this.records[index];
			if (record?.type === "checkpoint") return { cursor: record.cursor, messageId: record.messageId };
		}
		return {};
	}

	async resetConversation(detail = "new conversation requested"): Promise<void> {
		this.pendingJobs = [];
		this.activeJob = undefined;
		this.armedAfterRecordId = this.records.at(-1)?.recordId ?? 0;
		await this.appendRecord({
			type: "runtime",
			...buildRecordBase(this.channel, this.nextRecordId),
			event: "reset",
			detail,
		});
	}

	async appendError(message: string): Promise<void> {
		await this.appendRecord({
			type: "error",
			...buildRecordBase(this.channel, this.nextRecordId),
			message,
		});
	}

	getStatus(): ConversationStatus {
		return {
			channelKey: this.channelKey,
			logDir: this.log.dir,
			queueLength: this.pendingJobs.length,
			hasActiveJob: this.activeJob !== undefined,
			recordCount: this.records.length,
			lastRecordId: this.records.at(-1)?.recordId ?? 0,
			armed: this.armedAfterRecordId !== undefined,
		};
	}

	formatStatus(): string {
		const status = this.getStatus();
		const active = status.hasActiveJob ? "yes" : "no";
		return [
			`channel: ${status.channelKey}`,
			`records: ${status.recordCount}`,
			`last_record: ${status.lastRecordId}`,
			`queued: ${status.queueLength}`,
			`active_job: ${active}`,
			`armed: ${status.armed ? "yes" : "no"}`,
			`log_dir: ${status.logDir}`,
		].join("\n");
	}

	formatInboundForLog(record: InboundChatRecord): string {
		return `${formatAuthor(record.authorName, record.authorId)} @ ${record.ts}: ${record.text}`;
	}

	getRecords(): readonly ChatLogRecord[] {
		return this.records;
	}
}
