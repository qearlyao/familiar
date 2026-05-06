import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { FamiliarAgent } from "./agent.js";
import type { ChatLogRecord } from "./chat-log.js";
import type { Config, WebAuthMode } from "./config.js";
import type { DiscordDaemon, DiscordWebSession } from "./discord.js";
import { loadPersona, parsePersonaName } from "./persona.js";
import type { ConversationRuntime, InboundMessageInput, ParsedControlCommand } from "./runtime.js";
import type { EffectiveSetting } from "./settings.js";

const WEB_USER_NAME = "you";
const MAX_BODY_BYTES = 64 * 1024;
const EVENT_REPLAY_LIMIT = 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

type WebMessage = {
	id: string;
	role: "user" | "assistant" | "system";
	who: string;
	text: string;
	thinking?: string;
	thinkingMs?: number;
	ts: number;
};

type WebStreamEvent =
	| {
			type: "message_started";
			eventId: string;
			ts: number;
			channelKey?: string;
			messageId: string;
			role: "assistant" | "user";
			who: string;
	  }
	| {
			type: "delta";
			eventId: string;
			ts: number;
			channelKey?: string;
			messageId: string;
			part: "thinking" | "text";
			content: string;
			text: string;
	  }
	| {
			type: "message_completed";
			eventId: string;
			ts: number;
			channelKey?: string;
			messageId: string;
			thinkingMs?: number;
			usage?: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				cost: number;
			};
	  }
	| {
			type: "status";
			eventId: string;
			ts: number;
			channelKey?: string;
			kind: "thinking" | "tool" | "idle" | "queued";
			detail?: string;
	  }
	| {
			type: "error";
			eventId: string;
			ts: number;
			channelKey?: string;
			code: "rate_limited" | "tool_failed" | "abort" | "unknown";
			message: string;
	  }
	| {
			type: "replay_window_lost";
			eventId: string;
			ts: number;
			channelKey?: string;
	  };

interface WebDaemon {
	server: Server;
	stop(): Promise<void>;
}

interface WebSocketClient {
	socket: Socket;
	channelKey?: string;
	authed: boolean;
}

interface SessionRecord {
	expiresAt: number;
}

type WebPublishEvent = WebStreamEvent extends infer Event
	? Event extends { eventId: string; ts: number }
		? Omit<Event, "eventId" | "ts"> & { ts?: number }
		: never
	: never;

function getProjectRoot(): string {
	return resolve(fileURLToPath(import.meta.url), "../..");
}

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

function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(header: string | undefined): Record<string, string> {
	const cookies: Record<string, string> = {};
	for (const part of (header ?? "").split(";")) {
		const [name, ...valueParts] = part.trim().split("=");
		if (!name) continue;
		cookies[name] = decodeURIComponent(valueParts.join("="));
	}
	return cookies;
}

function decodeTotpSecret(secret: string): Buffer {
	const normalized = secret.replace(/\s+/g, "").replace(/=+$/g, "").toUpperCase();
	if (!/^[A-Z2-7]+$/.test(normalized)) return Buffer.from(secret, "utf8");
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = "";
	for (const char of normalized) {
		const value = alphabet.indexOf(char);
		if (value < 0) return Buffer.from(secret, "utf8");
		bits += value.toString(2).padStart(5, "0");
	}
	const bytes: number[] = [];
	for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
		bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
	}
	return Buffer.from(bytes);
}

function verifyTotp(secret: string, token: string, now = Date.now()): boolean {
	const normalized = token.replace(/\s+/g, "");
	if (!/^\d{6}$/.test(normalized)) return false;
	const secretBuffer = decodeTotpSecret(secret);
	const counter = Math.floor(now / 30000);
	for (let offset = -1; offset <= 1; offset++) {
		const counterBuffer = Buffer.alloc(8);
		counterBuffer.writeBigUInt64BE(BigInt(counter + offset));
		const hmac = createHmac("sha1", secretBuffer).update(counterBuffer).digest();
		const digestOffset = hmac[hmac.length - 1] & 0x0f;
		const code =
			(((hmac[digestOffset] & 0x7f) << 24) |
				((hmac[digestOffset + 1] & 0xff) << 16) |
				((hmac[digestOffset + 2] & 0xff) << 8) |
				(hmac[digestOffset + 3] & 0xff)) %
			1000000;
		if (safeEqual(code.toString().padStart(6, "0"), normalized)) return true;
	}
	return false;
}

function readBearerToken(request: IncomingMessage): string | undefined {
	const header = request.headers.authorization;
	if (!header) return undefined;
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match?.[1];
}

function createAuth(config: Config) {
	const sessions = new Map<string, SessionRecord>();

	const pruneSessions = () => {
		const now = Date.now();
		for (const [id, session] of sessions) {
			if (session.expiresAt <= now) sessions.delete(id);
		}
	};

	const hasBearer = (request: IncomingMessage): boolean => {
		if (!config.web.bearerToken) return false;
		const token = readBearerToken(request);
		return token !== undefined && safeEqual(token, config.web.bearerToken);
	};

	const hasSession = (request: IncomingMessage): boolean => {
		pruneSessions();
		const sessionId = parseCookies(request.headers.cookie).familiar_session;
		if (!sessionId) return false;
		return sessions.has(sessionId);
	};

	const authorize = (request: IncomingMessage, pathname: string): boolean => {
		if (pathname === "/api/web/auth/mode") return true;
		if (config.web.authMode === "tailscale-only") return true;
		if (config.web.authMode === "bearer") return hasBearer(request);
		return hasSession(request) || hasBearer(request);
	};

	const createSession = (): string => {
		pruneSessions();
		const id = randomBytes(32).toString("base64url");
		sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS });
		return id;
	};

	return { authorize, createSession };
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...headers,
	});
	response.end(JSON.stringify(body));
}

function sendText(response: ServerResponse, status: number, text: string): void {
	response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
	response.end(text);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
		chunks.push(buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	return raw ? JSON.parse(raw) : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function webMessageFromRecord(record: ChatLogRecord, assistantName: string): WebMessage | undefined {
	if (record.type === "inbound") {
		return {
			id: record.messageId,
			role: "user",
			who: record.authorName || WEB_USER_NAME,
			text: record.text,
			ts: toUnixMs(record.ts),
		};
	}
	if (record.type === "outbound" && !record.control) {
		return {
			id: record.messageIds[0] || `out_${record.recordId}`,
			role: "assistant",
			who: assistantName,
			text: record.text,
			thinking: record.thinking,
			thinkingMs: record.thinkingMs,
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

function usageFromAgentEvent(
	event: AgentEvent,
): WebStreamEvent extends infer T ? (T extends { type: "message_completed"; usage?: infer U } ? U : never) : never {
	if (event.type !== "message_end" || event.message.role !== "assistant") return undefined as never;
	const usage = event.message.usage;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cost: usage.cost.total,
	};
}

function encodeFrame(text: string): Buffer {
	const payload = Buffer.from(text, "utf8");
	let header: Buffer;
	if (payload.length < 126) {
		header = Buffer.from([0x81, payload.length]);
	} else if (payload.length <= 0xffff) {
		header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 126;
		header.writeUInt16BE(payload.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x81;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	return Buffer.concat([header, payload]);
}

function decodeFrames(buffer: Buffer): { messages: string[]; remaining: Buffer; close: boolean } {
	const messages: string[] = [];
	let offset = 0;
	let close = false;
	while (offset + 2 <= buffer.length) {
		const first = buffer[offset];
		const second = buffer[offset + 1];
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		let length = second & 0x7f;
		let headerLength = 2;
		if (length === 126) {
			if (offset + 4 > buffer.length) break;
			length = buffer.readUInt16BE(offset + 2);
			headerLength = 4;
		} else if (length === 127) {
			if (offset + 10 > buffer.length) break;
			const bigLength = buffer.readBigUInt64BE(offset + 2);
			if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame too large");
			length = Number(bigLength);
			headerLength = 10;
		}
		const maskLength = masked ? 4 : 0;
		const frameEnd = offset + headerLength + maskLength + length;
		if (frameEnd > buffer.length) break;
		const payloadStart = offset + headerLength + maskLength;
		const payload = Buffer.from(buffer.subarray(payloadStart, frameEnd));
		if (masked) {
			const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
			for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
		}
		if (opcode === 0x8) close = true;
		if (opcode === 0x1) messages.push(payload.toString("utf8"));
		offset = frameEnd;
	}
	return { messages, remaining: buffer.subarray(offset), close };
}

function mimeType(path: string): string {
	const extension = extname(path).toLowerCase();
	if (extension === ".html") return "text/html; charset=utf-8";
	if (extension === ".js") return "text/javascript; charset=utf-8";
	if (extension === ".css") return "text/css; charset=utf-8";
	if (extension === ".svg") return "image/svg+xml";
	if (extension === ".png") return "image/png";
	if (extension === ".ico") return "image/x-icon";
	return "application/octet-stream";
}

async function serveStatic(response: ServerResponse, requestPath: string): Promise<boolean> {
	const distDir = resolve(getProjectRoot(), "web/dist");
	if (!existsSync(distDir)) return false;
	const pathname = decodeURIComponent(requestPath.split("?")[0] || "/");
	const candidate = resolve(distDir, pathname === "/" ? "index.html" : pathname.slice(1));
	if (!candidate.startsWith(distDir)) {
		sendText(response, 403, "Forbidden");
		return true;
	}
	let filePath = candidate;
	const fileStat = await stat(filePath).catch(() => undefined);
	if (!fileStat?.isFile()) filePath = join(distDir, "index.html");
	const stream = createReadStream(filePath);
	response.writeHead(200, { "content-type": mimeType(filePath) });
	stream.pipe(response);
	return true;
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
): Promise<WebDaemon> {
	const persona = await loadPersona(config);
	const personaName = parsePersonaName(persona.soul);
	const auth = createAuth(config);
	const clients = new Set<WebSocketClient>();
	const eventsByChannel = new Map<string, WebStreamEvent[]>();
	const runtimeSubscriptions = new Map<string, () => void>();
	const locallyStreamedOutboundIds = new Set<string>();

	const publish = (event: WebPublishEvent): WebStreamEvent => {
		const fullEvent = { ...event, eventId: eventId(), ts: event.ts ?? Date.now() } as WebStreamEvent;
		const events = eventsByChannel.get(fullEvent.channelKey ?? "") ?? [];
		events.push(fullEvent);
		if (events.length > EVENT_REPLAY_LIMIT) events.shift();
		eventsByChannel.set(fullEvent.channelKey ?? "", events);
		const frame = encodeFrame(JSON.stringify(fullEvent));
		for (const client of clients) {
			if (client.authed && client.channelKey === fullEvent.channelKey && !client.socket.destroyed) {
				client.socket.write(frame);
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

	const subscribeRuntime = (runtime: ConversationRuntime): void => {
		if (runtimeSubscriptions.has(runtime.channelKey)) return;
		const unsubscribe = runtime.subscribe((record) => {
			if (record.type === "inbound") {
				publish({
					type: "message_started",
					channelKey: runtime.channelKey,
					messageId: record.messageId,
					role: "user",
					who: record.authorName || WEB_USER_NAME,
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
				const outboundId = record.messageIds[0] || `out_${record.recordId}`;
				if (locallyStreamedOutboundIds.delete(outboundId)) return;
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
				publish({
					type: "message_completed",
					channelKey: runtime.channelKey,
					messageId: outboundId,
					thinkingMs: record.thinkingMs,
					ts: toUnixMs(record.ts),
				});
			}
		});
		runtimeSubscriptions.set(runtime.channelKey, unsubscribe);
	};

	const getRuntime = async (channelKey?: string): Promise<ConversationRuntime> => {
		const runtime = await discordDaemon.getRuntimeForWebChannel(channelKey);
		subscribeRuntime(runtime);
		return runtime;
	};

	const getChannelKeyFromRequest = (url: URL, body?: unknown): string | undefined => {
		const queryKey = url.searchParams.get("channelKey");
		if (queryKey) return queryKey;
		if (isObject(body) && typeof body.channelKey === "string") return body.channelKey;
		return undefined;
	};

	const replay = (client: WebSocketClient, channelKey: string, lastEventId: string | null | undefined): void => {
		const events = eventsByChannel.get(channelKey) ?? [];
		if (!lastEventId) {
			client.authed = true;
			return;
		}
		const index = events.findIndex((event) => event.eventId === lastEventId);
		if (index < 0) {
			client.authed = true;
			client.socket.write(encodeFrame(JSON.stringify(publish({ type: "replay_window_lost", channelKey }))));
			return;
		}
		client.authed = true;
		for (const event of events.slice(index + 1)) {
			client.socket.write(encodeFrame(JSON.stringify(event)));
		}
	};

	const promptForRuntime = async (
		runtime: ConversationRuntime,
		jobId: string,
		prompt: string,
	): Promise<{ text: string; messageId: string; thinking: string; thinkingMs?: number }> => {
		const assistantMessageId = messageId();
		let thinkingStart: number | undefined;
		let thinkingEnd: number | undefined;
		let usage: ReturnType<typeof usageFromAgentEvent> | undefined;
		let started = false;
		let thinking = "";
		const reply = await discordDaemon.runPromptForWeb(runtime, jobId, prompt, (event: AgentEvent) => {
			if (event.type === "message_start" && event.message.role === "assistant" && !started) {
				started = true;
				publish({
					type: "message_started",
					channelKey: runtime.channelKey,
					messageId: assistantMessageId,
					role: "assistant",
					who: personaName,
				});
			}
			if (event.type === "message_update") {
				const assistantEvent = event.assistantMessageEvent;
				if (assistantEvent.type === "thinking_delta") {
					thinkingStart ??= Date.now();
					thinkingEnd = Date.now();
					thinking += assistantEvent.delta;
					publishDelta(runtime.channelKey, assistantMessageId, "thinking", assistantEvent.delta);
				}
				if (assistantEvent.type === "text_delta") {
					if (thinkingStart !== undefined && thinkingEnd === undefined) thinkingEnd = Date.now();
					publishDelta(runtime.channelKey, assistantMessageId, "text", assistantEvent.delta);
				}
			}
			if (event.type === "message_end" && event.message.role === "assistant") usage = usageFromAgentEvent(event);
		});
		if (!started) {
			publish({
				type: "message_started",
				channelKey: runtime.channelKey,
				messageId: assistantMessageId,
				role: "assistant",
				who: personaName,
			});
			publishDelta(runtime.channelKey, assistantMessageId, "text", reply);
		}
		const thinkingMs =
			thinkingStart !== undefined ? Math.max(0, (thinkingEnd ?? Date.now()) - thinkingStart) : undefined;
		publish({
			type: "message_completed",
			channelKey: runtime.channelKey,
			messageId: assistantMessageId,
			thinkingMs,
			usage,
		});
		locallyStreamedOutboundIds.add(assistantMessageId);
		return { text: reply, messageId: assistantMessageId, thinking, thinkingMs };
	};

	const drainJobs = async (runtime: ConversationRuntime): Promise<void> => {
		for (;;) {
			const dispatch = runtime.beginNextJob();
			if (!dispatch) return;
			try {
				const reply = await promptForRuntime(runtime, dispatch.job.jobId, dispatch.prompt);
				await runtime.completeActiveJob({
					text: reply.text,
					messageIds: [reply.messageId],
					thinking: reply.thinking,
					thinkingMs: reply.thinkingMs,
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
			discordDaemon.abortWebRuntime(runtime);
			await runtime.resetConversation("stop requested");
			publish({
				type: "status",
				channelKey: runtime.channelKey,
				kind: "idle",
				detail: "Stopped current work and cleared the chat queue.",
			});
			return "Stopped current work and cleared the chat queue.";
		}
		if (control.command === "new") {
			await familiarAgent.reset(runtime.channelKey);
			await runtime.resetConversation("new conversation requested");
			return "Started a fresh agent transcript for this channel.";
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
				const messages = runtime
					.getRecords()
					.map((record) => webMessageFromRecord(record, personaName))
					.filter((message): message is WebMessage => !!message);
				const end = before ? messages.findIndex((message) => message.id === before) : messages.length;
				const safeEnd = end >= 0 ? end : messages.length;
				const page = messages.slice(Math.max(0, safeEnd - limit), safeEnd);
				sendJson(response, 200, { messages: page, hasMore: safeEnd - limit > 0, channelKey: runtime.channelKey });
				return true;
			}
			if (request.method === "POST" && url.pathname === "/api/web/send") {
				const body = await readJsonBody(request);
				const runtime = await getRuntime(getChannelKeyFromRequest(url, body));
				if (!isObject(body) || typeof body.text !== "string" || !body.text.trim()) {
					sendJson(response, 400, { error: "text is required" });
					return true;
				}
				const id = messageId("user");
				const ts = Date.now();
				const input: InboundMessageInput = {
					messageId: id,
					authorId: config.discord.ownerId,
					authorName: WEB_USER_NAME,
					text: body.text,
					isBot: false,
					mentionedBot: true,
					remoteTimestamp: new Date(ts).toISOString(),
					checkpoint: { messageId: id },
				};
				await runtime.ingestInbound(input, { mode: "queue" });
				void drainJobs(runtime).catch((error) => console.error("Web job drain failed", error));
				sendJson(response, 200, { id, ts, channelKey: runtime.channelKey });
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
						{
							"set-cookie": `familiar_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
								SESSION_TTL_MS / 1000,
							)}; Path=/api/web`,
						},
					);
					return true;
				}
				const args = commandArgs(body.command, body.args);
				const input: InboundMessageInput = {
					messageId: messageId("control"),
					authorId: config.discord.ownerId,
					authorName: WEB_USER_NAME,
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
		const key = request.headers["sec-websocket-key"];
		if (typeof key !== "string") {
			netSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			netSocket.destroy();
			return;
		}
		const responseKey = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		netSocket.write(
			[
				"HTTP/1.1 101 Switching Protocols",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Accept: ${responseKey}`,
				"",
				"",
			].join("\r\n"),
		);
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
		netSocket.on("data", (chunk) => {
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
							discordDaemon.abortWebRuntime(runtime);
							await runtime.resetConversation("web abort requested");
							publish({
								type: "error",
								channelKey: runtime.channelKey,
								code: "abort",
								message: "Aborted current work.",
							});
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

export type { WebAuthMode, WebDaemon };
