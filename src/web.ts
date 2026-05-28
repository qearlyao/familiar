import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

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
import type { StoredAgentEvent, StoredAttachment } from "./chat-log.js";
import type { Config, WebAuthMode } from "./config.js";
import { clearConfigOverride, loadConfigOverrides, setConfigOverride } from "./config-overrides.js";
import { CONFIG_KEYS, CONFIG_REGISTRY, type ConfigKey, getConfigDefault, isConfigKey } from "./config-registry.js";
import { getContactNickname, refreshContactNote, setContactNotePath } from "./contact-note.js";
import type { RestartHandler } from "./control.js";
import type { DiscordDaemon } from "./discord.js";
import { eventId, messageId, toUnixMs } from "./ids.js";
import { materializeInboundAttachments } from "./inbound-attachments.js";
import { type ModelRef, PROVIDER_DEFAULTS, parseModelRef } from "./models.js";
import { loadPersona, parsePersonaName } from "./persona.js";
import type { ConversationRuntime, InboundMessageInput, ParsedControlCommand } from "./runtime.js";
import { formatSetting } from "./settings.js";
import { consumeSilentDelta, createSilentFilterState, finalizeSilentFilter, parseAgentReply } from "./silent-marker.js";
import { isRecord } from "./util/guards.js";
import { createAuth, sessionCookie, verifyTotp } from "./web/auth.js";
import { acceptWebSocket, decodeFrames, encodeFrame, replayEvents, type WebSocketClient } from "./web/events.js";
import { readJsonBody, sendJson, sendText } from "./web/http.js";
import { memeCatalogPath, parseMemeCatalog } from "./web/memes.js";
import { toolFromStoredAgentEvent, webAttachments, webHistoryPayload } from "./web/messages.js";
import { isWebUploadAttachment, readMultipartBody, type WebUploadAttachment } from "./web/multipart.js";
import { agentSettingsPayload, commandArgs, sessionDto } from "./web/payloads.js";
import { serveAttachment, serveStatic } from "./web/static.js";
import {
	EVENT_REPLAY_LIMIT,
	WEB_USER_NAME,
	type WebDaemon,
	type WebPublishEvent,
	type WebStreamEvent,
} from "./web/types.js";

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
	type InFlightMessage = {
		silentFilter?: ReturnType<typeof createSilentFilterState>;
		pendingStartTs?: number;
		locallyStreamed: boolean;
		startedSilent: boolean;
		lastActiveAt: number;
	};
	const IN_FLIGHT_TTL_MS = 10 * 60 * 1000;
	const inFlightMessages = new Map<string, InFlightMessage>();
	const getOrCreateInFlight = (messageIdValue: string): InFlightMessage => {
		let entry = inFlightMessages.get(messageIdValue);
		if (!entry) {
			entry = { locallyStreamed: false, startedSilent: false, lastActiveAt: Date.now() };
			inFlightMessages.set(messageIdValue, entry);
		} else {
			entry.lastActiveAt = Date.now();
		}
		return entry;
	};
	const touchInFlight = (messageIdValue: string): void => {
		const entry = inFlightMessages.get(messageIdValue);
		if (entry) entry.lastActiveAt = Date.now();
	};
	const inFlightGcTimer = setInterval(() => {
		const cutoff = Date.now() - IN_FLIGHT_TTL_MS;
		for (const [id, entry] of inFlightMessages) {
			if (entry.lastActiveAt < cutoff) inFlightMessages.delete(id);
		}
	}, 60 * 1000);
	inFlightGcTimer.unref?.();

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
		touchInFlight(messageIdValue);
		if (storedEvent.type === "message_start" && storedEvent.role === "assistant") {
			const entry = getOrCreateInFlight(messageIdValue);
			entry.locallyStreamed = true;
			entry.silentFilter = createSilentFilterState();
			entry.pendingStartTs = ts;
			entry.startedSilent = false;
		}
		const startedSilentMessage = (): boolean => {
			const entry = inFlightMessages.get(messageIdValue);
			if (!entry || entry.startedSilent) return false;
			const startTs = entry.pendingStartTs;
			entry.pendingStartTs = undefined;
			entry.startedSilent = true;
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
				const filter = inFlightMessages.get(messageIdValue)?.silentFilter;
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
			const entry = inFlightMessages.get(messageIdValue);
			const filter = entry?.silentFilter;
			let silent = false;
			if (filter && entry) {
				const final = finalizeSilentFilter(filter);
				silent = final.silent;
				if (!silent) {
					startedSilentMessage();
					if (final.flush) {
						publishDelta(channelKey, messageIdValue, "text", final.flush, ts);
					}
				} else {
					entry.startedSilent = true;
					entry.pendingStartTs = undefined;
				}
				entry.silentFilter = undefined;
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
					attachments: webAttachments(config, record.attachments),
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
				if (inFlightMessages.get(outboundId)?.locallyStreamed) {
					inFlightMessages.delete(outboundId);
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
		if (isRecord(body) && typeof body.channelKey === "string") return body.channelKey;
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
		const entry = getOrCreateInFlight(assistantMessageId);
		entry.locallyStreamed = true;
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
				return serveAttachment(config, response, url.pathname, request.headers.range);
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
				const before = url.searchParams.get("before") ?? undefined;
				sendJson(
					response,
					200,
					webHistoryPayload(config, runtime.getRecords(), personaName, runtime.channelKey, { limit, before }),
				);
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
				if (!isRecord(body)) {
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
				if (!isRecord(body)) {
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
				if (!isRecord(body) || typeof body.key !== "string") {
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
				if (!isRecord(body) || typeof body.key !== "string") {
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
				if (!isRecord(body) || typeof body.text !== "string") {
					sendJson(response, 400, { error: "text is required" });
					return true;
				}
				if (!isMultipart && isRecord(body) && Array.isArray(body.attachments) && body.attachments.length > 0) {
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
				if (!isRecord(body)) {
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
				if (!isRecord(body) || typeof body.command !== "string") {
					sendJson(response, 400, { error: "command is required" });
					return true;
				}
				if (config.web.authMode === "public-2fa" && body.command === "login") {
					const token = isRecord(body.args) && typeof body.args.token === "string" ? body.args.token : "";
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
		const requestedChannelKey = url.searchParams.get("channelKey") || undefined;
		void getRuntime(requestedChannelKey)
			.then((runtime) => {
				if (netSocket.destroyed) return;
				if (!acceptWebSocket(request, netSocket)) return;
				netSocket.setNoDelay(true);
				const client: WebSocketClient = { socket: netSocket, channelKey: runtime.channelKey, authed: false };
				clients.add(client);
				let frameBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
				netSocket.on("data", (chunk: Buffer) => {
					try {
						frameBuffer = Buffer.concat([frameBuffer, chunk]);
						const decoded = decodeFrames(frameBuffer);
						frameBuffer = decoded.remaining;
						if (decoded.close) netSocket.destroy();
						for (const raw of decoded.messages) {
							const message = JSON.parse(raw) as unknown;
							if (isRecord(message) && message.type === "hello") {
								if (!client.channelKey) continue;
								replay(
									client,
									client.channelKey,
									typeof message.lastEventId === "string" ? message.lastEventId : null,
								);
							}
							if (isRecord(message) && message.type === "abort") {
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
			})
			.catch((error) => {
				console.error("WebSocket runtime lookup failed", error);
				if (!netSocket.destroyed) {
					netSocket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
					netSocket.destroy();
				}
			});
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
			clearInterval(inFlightGcTimer);
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
