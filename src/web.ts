import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { getProviders } from "@earendil-works/pi-ai";
import { addModel, loadAddedModels, removeModel, setAddedModelsPath } from "./added-models.js";
import type { FamiliarAgent } from "./agent.js";
import {
	type AgentEventSummary,
	createAgentEventRecorder,
	storedAgentEventFromAgentEvent,
	thinkingDurationMs,
	updateAgentEventSummary,
} from "./agent-events.js";
import type { ChatLogRecord, StoredAgentEvent, StoredAttachment } from "./chat-log.js";
import type { Config, WebAuthMode } from "./config.js";
import { clearConfigOverride, loadConfigOverrides, setConfigOverride } from "./config-overrides.js";
import { CONFIG_KEYS, CONFIG_REGISTRY, type ConfigKey, getConfigDefault, isConfigKey } from "./config-registry.js";
import { getContactNickname, refreshContactNote, setContactNotePath } from "./contact-note.js";
import type { RestartHandler } from "./control.js";
import type { DiscordDaemon, DiscordWebSession } from "./discord.js";
import { publicAttachmentPath } from "./generated-media.js";
import { materializeInboundAttachments } from "./inbound-attachments.js";
import { type ModelRef, PROVIDER_DEFAULTS, parseModelRef, supportedThinkingLevels } from "./models.js";
import { loadPersona, parsePersonaName } from "./persona.js";
import type { ConversationRuntime, InboundMessageInput, ParsedControlCommand } from "./runtime.js";
import type { EffectiveSetting } from "./settings.js";
import { consumeSilentDelta, createSilentFilterState, finalizeSilentFilter, parseAgentReply } from "./silent-marker.js";
import { createAuth, sessionCookie, verifyTotp } from "./web-auth.js";
import { acceptWebSocket, decodeFrames, encodeFrame, replayEvents, type WebSocketClient } from "./web-events.js";
import { isObject, readJsonBody, sendJson, sendText } from "./web-http.js";
import { serveAttachment, serveStatic } from "./web-static.js";
import {
	EVENT_REPLAY_LIMIT,
	WEB_USER_NAME,
	type WebAttachment,
	type WebDaemon,
	type WebMessage,
	type WebPublishEvent,
	type WebStreamEvent,
	type WebToolEvent,
} from "./web-types.js";

function toUnixMs(ts: string | undefined): number {
	const parsed = ts ? Date.parse(ts) : NaN;
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function eventId(): string {
	return `evt_${randomUUID()}`;
}

function messageId(prefix = "msg"): string {
	return `${prefix}_${randomUUID()}`;
}

function isUserVisibleRuntimeRecord(record: ChatLogRecord): boolean {
	return record.type !== "runtime" || !["armed", "reset", "stopped"].includes(record.event);
}

interface WebUploadAttachment {
	name?: string;
	mimeType?: string;
	size?: number;
	buffer: Buffer;
}

interface WebMeme {
	name: string;
	url: string;
}

interface WebMemeFamily {
	name: string;
	memes: WebMeme[];
}

function parseMemeCatalog(markdown: string): WebMemeFamily[] {
	const families: WebMemeFamily[] = [];
	let currentFamily: WebMemeFamily | undefined;
	for (const line of markdown.split(/\r?\n/)) {
		const familyMatch = line.match(/^## (.+)$/);
		if (familyMatch) {
			currentFamily = { name: familyMatch[1]?.trim() ?? "", memes: [] };
			families.push(currentFamily);
			continue;
		}
		if (!currentFamily || !line.startsWith("- ") || !line.includes(" — ")) continue;
		const separator = line.indexOf(" — ");
		const name = line.slice(2, separator).trim();
		const suffix = line.slice(separator + " — ".length).trim();
		if (!name || !suffix) continue;
		currentFamily.memes.push({ name, url: `https://files.catbox.moe/${suffix}` });
	}
	return families;
}

function memeCatalogPath(config: Config): string {
	return join(config.workspacePath, "skills", "memes", "SKILL.md");
}

function isWebUploadAttachment(value: unknown): value is WebUploadAttachment {
	return !!value && typeof value === "object" && Buffer.isBuffer((value as { buffer?: unknown }).buffer);
}

async function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > maxBytes) throw new Error("Request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

function multipartBoundary(contentType: string | string[]): string {
	const header = Array.isArray(contentType) ? contentType.find((value) => value.includes("boundary=")) : contentType;
	const match = header?.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
	if (!match?.[1] && !match?.[2]) throw new Error("Missing multipart boundary");
	return match[1] ?? match[2] ?? "";
}

function parseContentDisposition(header: string): Record<string, string> {
	const parts = header.split(";").map((part) => part.trim());
	const values: Record<string, string> = {};
	for (const part of parts.slice(1)) {
		const [key, rawValue] = part.split("=");
		if (!key || rawValue === undefined) continue;
		values[key.toLowerCase()] = rawValue.replace(/^"|"$/g, "");
	}
	return values;
}

async function readMultipartBody(
	request: IncomingMessage,
	contentType: string | string[],
): Promise<Record<string, unknown>> {
	const boundary = multipartBoundary(contentType);
	const raw = await readRawBody(request, 32 * 1024 * 1024);
	const binary = raw.toString("binary");
	const marker = `--${boundary}`;
	const attachments: WebUploadAttachment[] = [];
	const body: Record<string, unknown> = { text: "" };
	for (const section of binary.split(marker).slice(1)) {
		if (!section || section === "--\r\n" || section === "--") continue;
		const trimmed = section.replace(/^\r\n/, "").replace(/\r\n--$/, "");
		const headerEnd = trimmed.indexOf("\r\n\r\n");
		if (headerEnd < 0) continue;
		const headerText = trimmed.slice(0, headerEnd);
		let contentBinary = trimmed.slice(headerEnd + 4);
		if (contentBinary.endsWith("\r\n")) contentBinary = contentBinary.slice(0, -2);
		const headers = Object.fromEntries(
			headerText.split("\r\n").map((line) => {
				const colon = line.indexOf(":");
				return colon >= 0
					? [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]
					: [line.toLowerCase(), ""];
			}),
		);
		const disposition = parseContentDisposition(headers["content-disposition"] ?? "");
		const name = disposition.name;
		if (!name) continue;
		if (name === "text" || name === "channelKey" || name === "clientId") {
			body[name] = Buffer.from(contentBinary, "binary").toString("utf8");
			continue;
		}
		if (name !== "attachments") continue;
		const buffer = Buffer.from(contentBinary, "binary");
		if (buffer.length === 0) continue;
		attachments.push({
			name: disposition.filename,
			mimeType: headers["content-type"],
			size: buffer.length,
			buffer,
		});
	}
	body.attachments = attachments;
	return body;
}

function webAttachments(config: Config, attachments: StoredAttachment[] | undefined): WebAttachment[] | undefined {
	if (!attachments?.length) return undefined;
	return attachments.map((attachment) => ({
		id: attachment.id,
		name: attachment.name,
		kind: attachment.kind,
		mimeType: attachment.mimeType,
		size: attachment.size,
		url: attachment.localPath ? publicAttachmentPath(config, attachment.localPath) : attachment.remoteUrl,
	}));
}

function attachmentDerivedText(attachment: StoredAttachment): string | undefined {
	return attachment.derived?.text?.text;
}

function toolError(result: unknown): string | undefined {
	if (typeof result === "string") return result;
	if (!isObject(result)) return undefined;
	if (typeof result.error === "string") return result.error;
	if (typeof result.message === "string") return result.message;
	return undefined;
}

function toolFromStoredAgentEvent(event: StoredAgentEvent, ts: number): WebToolEvent | undefined {
	if (event.type === "tool_execution_start") {
		return {
			id: event.toolCallId,
			name: event.toolName,
			status: "running",
			args: event.args,
			startedAt: ts,
			updatedAt: ts,
		};
	}
	if (event.type === "tool_execution_update") {
		return {
			id: event.toolCallId,
			name: event.toolName,
			status: "running",
			args: event.args,
			partialResult: event.partialResult,
			updatedAt: ts,
		};
	}
	if (event.type === "tool_execution_end") {
		return {
			id: event.toolCallId,
			name: event.toolName,
			status: event.isError ? "error" : "completed",
			result: event.result,
			error: event.isError ? toolError(event.result) : undefined,
			completedAt: ts,
			updatedAt: ts,
		};
	}
	if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end") {
		return {
			id: event.assistantMessageEvent.toolCall.id,
			name: event.assistantMessageEvent.toolCall.name,
			status: "pending",
			args: event.assistantMessageEvent.toolCall.arguments,
			updatedAt: ts,
		};
	}
	return undefined;
}

function mergeToolEvent(existing: WebToolEvent | undefined, patch: WebToolEvent): WebToolEvent {
	const terminal = patch.status === "completed" || patch.status === "error";
	return {
		...existing,
		...patch,
		args: patch.args ?? existing?.args,
		partialResult: terminal ? undefined : (patch.partialResult ?? existing?.partialResult),
		result: patch.result ?? existing?.result,
		error: patch.error ?? existing?.error,
		startedAt: existing?.startedAt ?? patch.startedAt,
	};
}

function applyStoredAgentEventToMessage(
	message: WebMessage,
	record: Extract<ChatLogRecord, { type: "agent_event" }>,
	options: { applyTextDeltas: boolean; applyThinkingDeltas: boolean },
): void {
	const event = record.event;
	const ts = toUnixMs(record.ts);
	if (event.type === "message_update") {
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type === "text_delta") {
			if (options.applyTextDeltas) message.text += assistantEvent.delta;
		}
		if (assistantEvent.type === "thinking_delta" && options.applyThinkingDeltas) {
			message.thinking = `${message.thinking ?? ""}${assistantEvent.delta}`;
		}
	}
	if (event.type === "message_end" && event.usage) message.usage = event.usage;
	const tool = toolFromStoredAgentEvent(event, ts);
	if (tool) {
		const tools = message.tools ?? [];
		const index = tools.findIndex((candidate) => candidate.id === tool.id);
		if (index >= 0) {
			tools[index] = mergeToolEvent(tools[index], tool);
		} else {
			tools.push(tool);
		}
		message.tools = tools;
	}
}

function webMessagesFromRecords(
	config: Config,
	records: readonly ChatLogRecord[],
	assistantName: string,
): WebMessage[] {
	const messages: WebMessage[] = [];
	const messagesById = new Map<string, WebMessage>();
	const pendingAgentEvents = new Map<string, Extract<ChatLogRecord, { type: "agent_event" }>[]>();
	for (const record of records) {
		const message = webMessageFromRecord(config, record, assistantName);
		if (message) {
			messages.push(message);
			messagesById.set(message.id, message);
			const pending = pendingAgentEvents.get(message.id) ?? [];
			for (const pendingRecord of pending) {
				applyStoredAgentEventToMessage(message, pendingRecord, {
					applyTextDeltas: !message.text,
					applyThinkingDeltas: !message.thinking,
				});
			}
			pendingAgentEvents.delete(message.id);
		}
		if (record.type === "agent_event") {
			const existing = messagesById.get(record.messageId);
			if (existing) {
				applyStoredAgentEventToMessage(existing, record, {
					applyTextDeltas: true,
					applyThinkingDeltas: true,
				});
			} else {
				const pending = pendingAgentEvents.get(record.messageId) ?? [];
				pending.push(record);
				pendingAgentEvents.set(record.messageId, pending);
			}
		}
	}
	return messages;
}

function webMessageFromRecord(config: Config, record: ChatLogRecord, assistantName: string): WebMessage | undefined {
	if (!isUserVisibleRuntimeRecord(record)) return undefined;
	if (record.type === "inbound") {
		const attachmentText = record.attachments
			.map((attachment) => attachmentDerivedText(attachment))
			.filter((text): text is string => !!text)
			.join("\n");
		return {
			id: record.messageId,
			role: "user",
			who: record.authorName || getContactNickname(WEB_USER_NAME),
			text: [record.text, attachmentText].filter(Boolean).join("\n"),
			attachments: webAttachments(config, record.attachments),
			ts: toUnixMs(record.ts),
		};
	}
	if (record.type === "outbound" && !record.control) {
		return {
			id: record.webMessageId || record.messageIds[0] || `out_${record.recordId}`,
			role: "assistant",
			who: assistantName,
			text: record.text,
			attachments: webAttachments(config, record.attachments),
			thinking: record.thinking,
			thinkingMs: record.thinkingMs,
			silent: record.silent || undefined,
			ts: toUnixMs(record.ts),
		};
	}
	if (record.type === "runtime" || record.type === "error") {
		return {
			id: `sys_${record.recordId}`,
			role: "system",
			who: "system",
			text: record.type === "runtime" ? record.detail || record.event : record.message,
			ts: toUnixMs(record.ts),
		};
	}
	return undefined;
}

function commandArgs(command: string, args: unknown): string {
	if (!isObject(args)) return "";
	if (command === "model") return typeof args.model === "string" ? args.model : "";
	if (command === "thinking") return typeof args.level === "string" ? args.level : "";
	if (command === "channel-trigger") return typeof args.trigger === "string" ? args.trigger : "";
	return "";
}

function formatSetting<T>(setting: EffectiveSetting<T>): string {
	return `${setting.value} (${setting.source})`;
}

function agentSettingsPayload(
	familiarAgent: FamiliarAgent,
	channelKey: string,
	personaName: string,
): Record<string, unknown> {
	const { model } = familiarAgent.resolveChannelModel(channelKey);
	return {
		model: familiarAgent.getModel(channelKey),
		thinking: familiarAgent.getThinkingLevel(channelKey),
		supportedThinking: supportedThinkingLevels(model),
		persona: { name: personaName },
	};
}

function sessionDto(session: DiscordWebSession): Record<string, unknown> {
	return {
		key: session.key,
		label: session.label,
		service: session.channel.service,
		scope: session.channel.scope,
		channelId: session.channel.channelId,
		channelName: session.channel.channelName,
		threadId: session.channel.threadId,
		isDefault: session.isDefault,
	};
}

export async function startWebDaemon(
	config: Config,
	familiarAgent: FamiliarAgent,
	discordDaemon: DiscordDaemon,
	options: { restart?: RestartHandler } = {},
): Promise<WebDaemon> {
	setAddedModelsPath(config.workspace.dataDir);
	setContactNotePath(config.persona.contact);
	await refreshContactNote();
	const persona = await loadPersona(config);
	const personaName = parsePersonaName(persona.soul);
	const auth = createAuth(config);
	const clients = new Set<WebSocketClient>();
	const eventsByChannel = new Map<string, WebStreamEvent[]>();
	const runtimeSubscriptions = new Map<string, () => void>();
	const locallyStreamedOutboundIds = new Set<string>();
	const silentFilters = new Map<string, ReturnType<typeof createSilentFilterState>>();
	const pendingMessageStarts = new Map<string, number | undefined>();

	const publish = (event: WebPublishEvent): WebStreamEvent => {
		const fullEvent = { ...event, eventId: eventId(), ts: event.ts ?? Date.now() } as WebStreamEvent;
		const events = eventsByChannel.get(fullEvent.channelKey ?? "") ?? [];
		events.push(fullEvent);
		if (events.length > EVENT_REPLAY_LIMIT) events.shift();
		eventsByChannel.set(fullEvent.channelKey ?? "", events);
		const frame = encodeFrame(JSON.stringify(fullEvent));
		for (const client of clients) {
			if (client.channelKey === fullEvent.channelKey && !client.socket.destroyed) {
				if (client.authed) {
					client.socket.write(frame);
				} else {
					const pendingEvents = client.pendingEvents ?? [];
					pendingEvents.push(fullEvent);
					client.pendingEvents = pendingEvents;
				}
			}
		}
		return fullEvent;
	};

	const publishDelta = (
		channelKey: string,
		messageIdValue: string,
		part: "thinking" | "text",
		text: string,
		ts?: number,
	): WebStreamEvent =>
		publish({ type: "delta", channelKey, messageId: messageIdValue, part, content: text, text, ts });

	const publishStoredAgentEvent = (
		channelKey: string,
		messageIdValue: string,
		storedEvent: StoredAgentEvent,
		ts?: number,
	): void => {
		if (storedEvent.type === "message_start" && storedEvent.role === "assistant") {
			locallyStreamedOutboundIds.add(messageIdValue);
			silentFilters.set(messageIdValue, createSilentFilterState());
			pendingMessageStarts.set(messageIdValue, ts);
		}
		const startedSilentMessage = (): boolean => {
			if (!pendingMessageStarts.has(messageIdValue)) return false;
			const startTs = pendingMessageStarts.get(messageIdValue);
			pendingMessageStarts.delete(messageIdValue);
			publish({
				type: "message_started",
				channelKey,
				messageId: messageIdValue,
				role: "assistant",
				who: personaName,
				ts: startTs,
			});
			return true;
		};
		if (storedEvent.type === "message_update") {
			const assistantEvent = storedEvent.assistantMessageEvent;
			if (assistantEvent.type === "thinking_delta") {
				startedSilentMessage();
				publishDelta(channelKey, messageIdValue, "thinking", assistantEvent.delta, ts);
			}
			if (assistantEvent.type === "text_delta") {
				const filter = silentFilters.get(messageIdValue);
				if (!filter) {
					startedSilentMessage();
					publishDelta(channelKey, messageIdValue, "text", assistantEvent.delta, ts);
				} else {
					const result = consumeSilentDelta(filter, assistantEvent.delta);
					if (result.kind === "emit" && result.text) {
						startedSilentMessage();
						publishDelta(channelKey, messageIdValue, "text", result.text, ts);
					}
				}
			}
		}
		if (storedEvent.type === "tool_execution_start") {
			startedSilentMessage();
		}
		if (storedEvent.type === "message_end" && storedEvent.role === "assistant") {
			const filter = silentFilters.get(messageIdValue);
			let silent = false;
			if (filter) {
				const final = finalizeSilentFilter(filter);
				silent = final.silent;
				if (!silent) {
					startedSilentMessage();
					if (final.flush) {
						publishDelta(channelKey, messageIdValue, "text", final.flush, ts);
					}
				} else {
					pendingMessageStarts.delete(messageIdValue);
				}
				silentFilters.delete(messageIdValue);
			} else {
				startedSilentMessage();
			}
			publish({
				type: "message_completed",
				channelKey,
				messageId: messageIdValue,
				usage: storedEvent.usage,
				silent: silent || undefined,
				ts,
			});
		}
		const tool = toolFromStoredAgentEvent(storedEvent, ts ?? Date.now());
		if (tool) publish({ type: "tool_event", channelKey, messageId: messageIdValue, tool, ts });
	};

	const subscribeRuntime = (runtime: ConversationRuntime): void => {
		if (runtimeSubscriptions.has(runtime.channelKey)) return;
		const unsubscribeRecords = runtime.subscribe((record) => {
			if (record.type === "inbound") {
				publish({
					type: "message_started",
					channelKey: runtime.channelKey,
					messageId: record.messageId,
					role: "user",
					who: record.authorName || getContactNickname(WEB_USER_NAME),
					ts: toUnixMs(record.ts),
				});
				publishDelta(runtime.channelKey, record.messageId, "text", record.text, toUnixMs(record.ts));
				publish({
					type: "message_completed",
					channelKey: runtime.channelKey,
					messageId: record.messageId,
					ts: toUnixMs(record.ts),
				});
			}
			if (record.type === "outbound" && !record.control) {
				const outboundId = record.webMessageId || record.messageIds[0] || `out_${record.recordId}`;
				const completion = {
					type: "message_completed" as const,
					channelKey: runtime.channelKey,
					messageId: outboundId,
					thinkingMs: record.thinkingMs,
					attachments: webAttachments(config, record.attachments),
					silent: record.silent || undefined,
					ts: toUnixMs(record.ts),
				};
				if (locallyStreamedOutboundIds.delete(outboundId)) {
					publish(completion);
					return;
				}
				if (!record.silent) {
					publish({
						type: "message_started",
						channelKey: runtime.channelKey,
						messageId: outboundId,
						role: "assistant",
						who: personaName,
						ts: toUnixMs(record.ts),
					});
					if (record.thinking)
						publishDelta(runtime.channelKey, outboundId, "thinking", record.thinking, toUnixMs(record.ts));
					if (record.text) publishDelta(runtime.channelKey, outboundId, "text", record.text, toUnixMs(record.ts));
				}
				publish(completion);
			}
		});
		const unsubscribeAgentEvents = runtime.subscribeAgentEvents((agentEvent) => {
			publishStoredAgentEvent(runtime.channelKey, agentEvent.messageId, agentEvent.event, agentEvent.ts);
		});
		runtimeSubscriptions.set(runtime.channelKey, () => {
			unsubscribeRecords();
			unsubscribeAgentEvents();
		});
	};

	const getRuntime = async (channelKey?: string): Promise<ConversationRuntime> => {
		const runtime = await discordDaemon.getRuntimeForWebChannel(channelKey);
		subscribeRuntime(runtime);
		return runtime;
	};

	const subscribeKnownRuntimes = async (): Promise<void> => {
		const sessions = await discordDaemon.getWebSessions();
		await Promise.all(
			sessions.map(async (session) => {
				const runtime = await discordDaemon.getRuntimeForWebChannel(session.key);
				subscribeRuntime(runtime);
			}),
		);
	};

	const getChannelKeyFromRequest = (url: URL, body?: unknown): string | undefined => {
		const queryKey = url.searchParams.get("channelKey");
		if (queryKey) return queryKey;
		if (isObject(body) && typeof body.channelKey === "string") return body.channelKey;
		return undefined;
	};

	const getAgentModelsPayload = (): { models: string[]; added: string[] } => {
		const models: string[] = [];
		const added: string[] = [];
		const seen = new Set<string>();
		for (const model of config.models.allow) {
			if (seen.has(model)) continue;
			seen.add(model);
			models.push(model);
		}
		for (const model of loadAddedModels()) {
			if (seen.has(model)) continue;
			seen.add(model);
			models.push(model);
			added.push(model);
		}
		return { models, added };
	};

	const getConfigPayload = (): { values: Record<ConfigKey, { value: unknown; source: "config" | "override" }> } => {
		const overrides = loadConfigOverrides();
		const values = {} as Record<ConfigKey, { value: unknown; source: "config" | "override" }>;
		for (const key of CONFIG_KEYS) {
			const entry = CONFIG_REGISTRY[key];
			values[key] = {
				value: entry.read(config),
				source: key in overrides ? "override" : "config",
			};
		}
		return { values };
	};

	const parseRequestedModel = (
		value: unknown,
	): { ok: true; model: string; ref: ModelRef } | { ok: false; error: string } => {
		if (typeof value !== "string") return { ok: false, error: "format must be provider/model-id" };
		const ref = parseModelRef(value);
		if (!ref) return { ok: false, error: "format must be provider/model-id" };
		return { ok: true, model: ref.key, ref };
	};

	const replay = (client: WebSocketClient, channelKey: string, lastEventId: string | null | undefined): void => {
		const events = eventsByChannel.get(channelKey) ?? [];
		replayEvents(client, events, lastEventId, () => publish({ type: "replay_window_lost", channelKey }));
	};

	const promptForRuntime = async (
		runtime: ConversationRuntime,
		jobId: string,
		prompt: string,
		attachments: StoredAttachment[] = [],
		onTurnEnd?: () => void | Promise<void>,
	): Promise<{
		text: string;
		messageId: string;
		thinking: string;
		thinkingMs?: number;
		attachments?: StoredAttachment[];
		silent?: boolean;
	}> => {
		const assistantMessageId = messageId();
		const summary: AgentEventSummary = { thinking: "" };
		const recorder = createAgentEventRecorder((storedEvent) =>
			runtime.noteAgentEvent(jobId, assistantMessageId, storedEvent, { notify: false }),
		);
		let started = false;
		let reply: Awaited<ReturnType<typeof discordDaemon.runPromptForWeb>>;
		try {
			reply = await discordDaemon.runPromptForWeb(
				runtime,
				jobId,
				prompt,
				attachments,
				async (event: AgentEvent) => {
					if (event.type === "message_start" && event.message.role === "assistant" && !started) {
						started = true;
					}
					updateAgentEventSummary(summary, event);
					const storedEvent = storedAgentEventFromAgentEvent(event);
					if (storedEvent) {
						runtime.publishAgentEvent(jobId, assistantMessageId, storedEvent);
						await recorder.record(storedEvent);
					}
				},
				onTurnEnd,
			);
		} finally {
			await recorder.flush();
		}
		const parsed = parseAgentReply(reply.text);
		const finalText = parsed.silent ? "" : reply.text;
		if (!started && !parsed.silent) {
			publish({
				type: "message_started",
				channelKey: runtime.channelKey,
				messageId: assistantMessageId,
				role: "assistant",
				who: personaName,
			});
			if (finalText) {
				publishDelta(runtime.channelKey, assistantMessageId, "text", finalText);
			}
		}
		const thinkingMs = thinkingDurationMs(summary);
		publish({
			type: "message_completed",
			channelKey: runtime.channelKey,
			messageId: assistantMessageId,
			thinkingMs,
			attachments: webAttachments(config, reply.attachments),
			silent: parsed.silent || undefined,
		});
		locallyStreamedOutboundIds.add(assistantMessageId);
		return {
			text: finalText,
			messageId: assistantMessageId,
			thinking: summary.thinking,
			thinkingMs,
			attachments: reply.attachments,
			silent: parsed.silent,
		};
	};

	const drainJobs = async (runtime: ConversationRuntime): Promise<void> => {
		for (;;) {
			const dispatch = runtime.beginNextJob();
			if (!dispatch) return;
			try {
				const reply = await promptForRuntime(
					runtime,
					dispatch.job.jobId,
					dispatch.prompt,
					dispatch.attachments,
					() => {
						publish({
							type: "status",
							channelKey: runtime.channelKey,
							kind: "idle",
						});
					},
				);
				await runtime.completeActiveJob({
					text: reply.text,
					messageIds: [reply.messageId],
					webMessageId: reply.messageId,
					attachments: reply.attachments,
					thinking: reply.thinking,
					thinkingMs: reply.thinkingMs,
					silent: reply.silent,
					replyToMessageId: dispatch.triggerMessageId,
				});
			} catch (error) {
				if (!runtime.hasActiveJob(dispatch.job.jobId)) return;
				const message = error instanceof Error ? error.message : String(error);
				await runtime.failActiveJob(message);
				await runtime.appendError(message);
				publish({ type: "error", channelKey: runtime.channelKey, code: "unknown", message });
			}
		}
	};

	const applyControlCommand = async (runtime: ConversationRuntime, control: ParsedControlCommand): Promise<string> => {
		if (control.command === "stop") {
			familiarAgent.requestSoftStop(runtime.channelKey);
			return "Stopped after current step. Conversation preserved.";
		}
		if (control.command === "new") {
			await familiarAgent.reset(runtime.channelKey);
			await runtime.resetConversation("new conversation requested");
			return "Started a fresh agent transcript for this channel.";
		}
		if (control.command === "reload") {
			return familiarAgent.reload();
		}
		if (control.command === "restart") {
			return options.restart
				? await options.restart()
				: "Restart requested, but no restart handler is configured. Please restart the Familiar process manually.";
		}
		if (control.command === "model") {
			return control.args
				? await familiarAgent.setModel(runtime.channelKey, control.args)
				: `Current model: ${formatSetting(familiarAgent.getModel(runtime.channelKey))}`;
		}
		if (control.command === "thinking") {
			return control.args
				? await familiarAgent.setThinkingLevel(runtime.channelKey, control.args)
				: `Current thinking: ${formatSetting(familiarAgent.getThinkingLevel(runtime.channelKey))}`;
		}
		if (control.command === "channel-trigger") return "Use Discord /familiar channel-trigger in the channel for now.";
		if (control.command === "status") {
			return [
				runtime.formatStatus(),
				`model: ${formatSetting(familiarAgent.getModel(runtime.channelKey))}`,
				`thinking: ${formatSetting(familiarAgent.getThinkingLevel(runtime.channelKey))}`,
			].join("\n");
		}
		return "Compact is not wired for this runtime yet. I logged the command, but I won't run lossy compaction here.";
	};

	const handleApi = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
		if (!url.pathname.startsWith("/api/web/")) return false;
		if (!auth.authorize(request, url.pathname)) {
			sendJson(response, 401, { error: "unauthorized" });
			return true;
		}
		try {
			if (request.method === "GET" && url.pathname.startsWith("/api/web/attachments/")) {
				return serveAttachment(config, response, url.pathname);
			}
			if (request.method === "GET" && url.pathname === "/api/web/auth/mode") {
				sendJson(response, 200, { mode: config.web.authMode, personaName });
				return true;
			}
			if (request.method === "GET" && url.pathname === "/api/web/sessions") {
				const sessions = await discordDaemon.getWebSessions();
				sendJson(response, 200, { sessions: sessions.map(sessionDto) });
				return true;
			}
			if (request.method === "GET" && url.pathname === "/api/web/history") {
				const runtime = await getRuntime(getChannelKeyFromRequest(url));
				const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
				const before = url.searchParams.get("before");
				const messages = webMessagesFromRecords(config, runtime.getRecords(), personaName);
				const end = before ? messages.findIndex((message) => message.id === before) : messages.length;
				const safeEnd = end >= 0 ? end : messages.length;
				const page = messages.slice(Math.max(0, safeEnd - limit), safeEnd);
				sendJson(response, 200, { messages: page, hasMore: safeEnd - limit > 0, channelKey: runtime.channelKey });
				return true;
			}
			if (request.method === "GET" && url.pathname === "/api/web/agent/settings") {
				const runtime = await getRuntime(getChannelKeyFromRequest(url));
				sendJson(response, 200, agentSettingsPayload(familiarAgent, runtime.channelKey, personaName));
				return true;
			}
			if (request.method === "GET" && url.pathname === "/api/web/agent/models") {
				sendJson(response, 200, getAgentModelsPayload());
				return true;
			}
			if (request.method === "POST" && url.pathname === "/api/web/agent/models") {
				const body = await readJsonBody(request);
				if (!isObject(body)) {
					sendJson(response, 400, { error: "body is required" });
					return true;
				}
				const parsed = parseRequestedModel(body.model);
				if (!parsed.ok) {
					sendJson(response, 400, { error: parsed.error });
					return true;
				}
				if (
					!Object.hasOwn(PROVIDER_DEFAULTS, parsed.ref.provider) &&
					!getProviders().includes(parsed.ref.provider as never)
				) {
					sendJson(response, 400, { error: `unsupported provider: ${parsed.ref.provider}` });
					return true;
				}
				if (config.models.allow.includes(parsed.model) || loadAddedModels().includes(parsed.model)) {
					sendJson(response, 200, getAgentModelsPayload());
					return true;
				}
				await addModel(parsed.model);
				sendJson(response, 200, getAgentModelsPayload());
				return true;
			}
			if (request.method === "DELETE" && url.pathname === "/api/web/agent/models") {
				const body = await readJsonBody(request);
				if (!isObject(body)) {
					sendJson(response, 400, { error: "body is required" });
					return true;
				}
				const parsed = parseRequestedModel(body.model);
				if (!parsed.ok) {
					sendJson(response, 400, { error: parsed.error });
					return true;
				}
				if (!loadAddedModels().includes(parsed.model)) {
					sendJson(response, 400, { error: "model is not user-added" });
					return true;
				}
				await removeModel(parsed.model);
				sendJson(response, 200, getAgentModelsPayload());
				return true;
			}
			if (request.method === "GET" && url.pathname === "/api/web/config") {
				sendJson(response, 200, getConfigPayload());
				return true;
			}
			if (request.method === "POST" && url.pathname === "/api/web/config") {
				const body = await readJsonBody(request);
				if (!isObject(body) || typeof body.key !== "string") {
					sendJson(response, 400, { error: "key is required" });
					return true;
				}
				if (!isConfigKey(body.key)) {
					sendJson(response, 400, { error: `unknown config key: ${body.key}` });
					return true;
				}
				const entry = CONFIG_REGISTRY[body.key];
				try {
					const validated = entry.validate(body.value, config);
					entry.write(config, validated);
					await setConfigOverride(body.key, validated);
					await entry.apply?.({ config, discordDaemon });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					sendJson(response, 400, { error: message });
					return true;
				}
				sendJson(response, 200, getConfigPayload());
				return true;
			}
			if (request.method === "DELETE" && url.pathname === "/api/web/config") {
				const body = await readJsonBody(request);
				if (!isObject(body) || typeof body.key !== "string") {
					sendJson(response, 400, { error: "key is required" });
					return true;
				}
				if (!isConfigKey(body.key)) {
					sendJson(response, 400, { error: `unknown config key: ${body.key}` });
					return true;
				}
				const entry = CONFIG_REGISTRY[body.key];
				try {
					const fallback = getConfigDefault(body.key);
					entry.write(config, fallback);
					await clearConfigOverride(body.key);
					await entry.apply?.({ config, discordDaemon });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					sendJson(response, 400, { error: message });
					return true;
				}
				sendJson(response, 200, getConfigPayload());
				return true;
			}
			if (request.method === "GET" && url.pathname === "/api/web/memes") {
				try {
					const markdown = await readFile(memeCatalogPath(config), "utf8");
					sendJson(response, 200, { families: parseMemeCatalog(markdown) });
				} catch {
					sendJson(response, 500, { error: "memes catalog unavailable" });
				}
				return true;
			}
			if (request.method === "POST" && url.pathname === "/api/web/send") {
				const contentType = request.headers["content-type"] ?? "";
				const isMultipart = Array.isArray(contentType)
					? contentType.some((value) => value.includes("multipart/form-data"))
					: contentType.includes("multipart/form-data");
				const body = isMultipart ? await readMultipartBody(request, contentType) : await readJsonBody(request);
				const runtime = await getRuntime(getChannelKeyFromRequest(url, body));
				if (!isObject(body) || typeof body.text !== "string") {
					sendJson(response, 400, { error: "text is required" });
					return true;
				}
				if (!isMultipart && isObject(body) && Array.isArray(body.attachments) && body.attachments.length > 0) {
					sendJson(response, 400, { error: "attachments require multipart form data" });
					return true;
				}
				const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
				const attachments = await materializeInboundAttachments(
					config,
					rawAttachments
						.filter((attachment): attachment is WebUploadAttachment => isWebUploadAttachment(attachment))
						.map((attachment) => ({ ...attachment, source: "web" })),
				);
				if (!body.text.trim() && attachments.length === 0) {
					sendJson(response, 400, { error: "text or attachment is required" });
					return true;
				}
				const id = messageId("user");
				const ts = Date.now();
				const input: InboundMessageInput = {
					messageId: id,
					authorId: config.discord.ownerId,
					authorName: getContactNickname(WEB_USER_NAME),
					text: body.text,
					isBot: false,
					mentionedBot: true,
					remoteTimestamp: new Date(ts).toISOString(),
					checkpoint: { messageId: id },
					attachments,
				};
				await runtime.ingestInbound(input, { mode: "queue" });
				void drainJobs(runtime).catch((error) => console.error("Web job drain failed", error));
				sendJson(response, 200, { id, ts, channelKey: runtime.channelKey });
				return true;
			}
			if (request.method === "POST" && url.pathname === "/api/web/agent/settings") {
				const body = await readJsonBody(request);
				const runtime = await getRuntime(getChannelKeyFromRequest(url, body));
				if (!isObject(body)) {
					sendJson(response, 400, { error: "body is required" });
					return true;
				}
				try {
					if (typeof body.model === "string") await familiarAgent.setModel(runtime.channelKey, body.model);
					if (typeof body.thinking === "string")
						await familiarAgent.setThinkingLevel(runtime.channelKey, body.thinking);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					sendJson(response, 400, { error: message });
					return true;
				}
				sendJson(response, 200, agentSettingsPayload(familiarAgent, runtime.channelKey, personaName));
				return true;
			}
			if (request.method === "POST" && url.pathname === "/api/web/agent/new") {
				const body = await readJsonBody(request);
				const runtime = await getRuntime(getChannelKeyFromRequest(url, body));
				await familiarAgent.reset(runtime.channelKey);
				await runtime.resetConversation("new conversation requested from web");
				publish({
					type: "status",
					channelKey: runtime.channelKey,
					kind: "idle",
					detail: "started fresh from web",
				});
				sendJson(response, 200, { ok: true });
				return true;
			}
			if (request.method === "POST" && url.pathname === "/api/web/control") {
				const body = await readJsonBody(request);
				const runtime = await getRuntime(getChannelKeyFromRequest(url, body));
				if (!isObject(body) || typeof body.command !== "string") {
					sendJson(response, 400, { error: "command is required" });
					return true;
				}
				if (config.web.authMode === "public-2fa" && body.command === "login") {
					const token = isObject(body.args) && typeof body.args.token === "string" ? body.args.token : "";
					if (!config.web.totpSecret || !verifyTotp(config.web.totpSecret, token)) {
						sendJson(response, 401, { ok: false, message: "Invalid TOTP token." });
						return true;
					}
					const sessionId = auth.createSession();
					sendJson(
						response,
						200,
						{ ok: true, message: "Authenticated." },
						{ "set-cookie": sessionCookie(sessionId) },
					);
					return true;
				}
				const args = commandArgs(body.command, body.args);
				const input: InboundMessageInput = {
					messageId: messageId("control"),
					authorId: config.discord.ownerId,
					authorName: getContactNickname(WEB_USER_NAME),
					text: `/${body.command}${args ? ` ${args}` : ""}`,
					isBot: false,
					mentionedBot: true,
					remoteTimestamp: new Date().toISOString(),
				};
				const control = runtime.parseControlCommand(input);
				if (!control) {
					sendJson(response, 400, { ok: false, message: "Unsupported command." });
					return true;
				}
				await runtime.noteControlCommand(input, control);
				const message = await applyControlCommand(runtime, control);
				await runtime.noteOutbound({ text: message, messageIds: [], control: control.command });
				sendJson(response, 200, { ok: true, message, channelKey: runtime.channelKey });
				return true;
			}
			sendJson(response, 404, { error: "not found" });
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
			return true;
		}
	};

	await subscribeKnownRuntimes();

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		void handleApi(request, response, url).then(async (handled) => {
			if (handled) return;
			if (await serveStatic(response, url.pathname)) return;
			sendText(response, 404, "Not found");
		});
	});

	server.on("upgrade", (request, socket) => {
		const netSocket = socket as Socket;
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		if (url.pathname !== "/api/web/stream" || !auth.authorize(request, url.pathname)) {
			netSocket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			netSocket.destroy();
			return;
		}
		if (!acceptWebSocket(request, netSocket)) return;
		netSocket.setNoDelay(true);
		const requestedChannelKey = url.searchParams.get("channelKey") || undefined;
		const client: WebSocketClient = { socket: netSocket, channelKey: requestedChannelKey, authed: false };
		clients.add(client);
		let frameBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		void getRuntime(requestedChannelKey)
			.then((runtime) => {
				client.channelKey = runtime.channelKey;
			})
			.catch((error) => {
				console.error("WebSocket runtime lookup failed", error);
				netSocket.destroy();
			});
		netSocket.on("data", (chunk: Buffer) => {
			try {
				frameBuffer = Buffer.concat([frameBuffer, chunk]);
				const decoded = decodeFrames(frameBuffer);
				frameBuffer = decoded.remaining;
				if (decoded.close) netSocket.destroy();
				for (const raw of decoded.messages) {
					const message = JSON.parse(raw) as unknown;
					if (isObject(message) && message.type === "hello") {
						if (!client.channelKey) continue;
						replay(
							client,
							client.channelKey,
							typeof message.lastEventId === "string" ? message.lastEventId : null,
						);
					}
					if (isObject(message) && message.type === "abort") {
						void getRuntime(client.channelKey).then(async (runtime) => {
							familiarAgent.requestSoftStop(runtime.channelKey);
						});
					}
				}
			} catch (error) {
				console.error("WebSocket frame handling failed", error);
				netSocket.destroy();
			}
		});
		netSocket.on("close", () => clients.delete(client));
		netSocket.on("error", () => clients.delete(client));
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(config.web.port, config.web.bindAddress, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	console.log(`Web side-door listening on http://${config.web.bindAddress}:${config.web.port}`);

	return {
		server,
		async stop(): Promise<void> {
			for (const client of clients) client.socket.destroy();
			clients.clear();
			for (const unsubscribe of runtimeSubscriptions.values()) unsubscribe();
			runtimeSubscriptions.clear();
			await new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => (error ? rejectClose(error) : resolveClose()));
			});
		},
	};
}

export const __webTest = {
	memeCatalogPath,
	parseMemeCatalog,
};

export type { WebAuthMode, WebDaemon };
