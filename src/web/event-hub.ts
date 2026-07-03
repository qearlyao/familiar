import type { Config } from "../config/index.js";
import type { StoredAgentEvent } from "../conversation/chat-log.js";
import { getContactNickname } from "../conversation/contact-note.js";
import { eventId, toUnixMs } from "../conversation/ids.js";
import type { ConversationRuntime } from "../runtime/conversation-runtime.js";
import { parseAgentReply } from "../runtime/silent-marker.js";
import { encodeFrame, replayEvents, type WebSocketClient } from "./events.js";
import { toolFromStoredAgentEvent, webAttachments } from "./messages.js";
import { EVENT_REPLAY_LIMIT, WEB_USER_NAME, type WebPublishEvent, type WebStreamEvent } from "./types.js";

type InFlightMessage = {
	text: string;
	locallyStreamed: boolean;
	lastActiveAt: number;
};

const IN_FLIGHT_TTL_MS = 10 * 60 * 1000;

export interface WebEventHub {
	publish(event: WebPublishEvent): WebStreamEvent;
	publishDelta(
		channelKey: string,
		messageIdValue: string,
		part: "thinking" | "text",
		text: string,
		ts?: number,
	): WebStreamEvent;
	appendAndPublishError(runtime: ConversationRuntime, message: string): Promise<void>;
	markLocallyStreamed(messageIdValue: string): void;
	subscribeRuntime(runtime: ConversationRuntime): void;
	replay(client: WebSocketClient, channelKey: string, lastEventId: string | null | undefined): void;
	registerClient(client: WebSocketClient): () => void;
	stop(): void;
}

export function createWebEventHub(config: Config, personaName: string): WebEventHub {
	const clients = new Set<WebSocketClient>();
	const eventsByChannel = new Map<string, WebStreamEvent[]>();
	const runtimeSubscriptions = new Map<string, () => void>();
	const inFlightMessages = new Map<string, InFlightMessage>();

	const getOrCreateInFlight = (messageIdValue: string): InFlightMessage => {
		let entry = inFlightMessages.get(messageIdValue);
		if (!entry) {
			entry = { text: "", locallyStreamed: false, lastActiveAt: Date.now() };
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
			entry.text = "";
			publish({
				type: "message_started",
				channelKey,
				messageId: messageIdValue,
				role: "assistant",
				who: personaName,
				ts,
			});
		}
		if (storedEvent.type === "message_update") {
			const assistantEvent = storedEvent.assistantMessageEvent;
			if (assistantEvent.type === "thinking_delta") {
				publishDelta(channelKey, messageIdValue, "thinking", assistantEvent.delta, ts);
			}
			if (assistantEvent.type === "text_delta") {
				const entry = inFlightMessages.get(messageIdValue);
				if (entry) entry.text += assistantEvent.delta;
				publishDelta(channelKey, messageIdValue, "text", assistantEvent.delta, ts);
			}
		}
		if (storedEvent.type === "message_end" && storedEvent.role === "assistant") {
			const entry = inFlightMessages.get(messageIdValue);
			const silent = entry ? parseAgentReply(entry.text).silent : false;
			publish({
				type: "message_completed",
				channelKey,
				messageId: messageIdValue,
				usage: storedEvent.usage,
				silent: silent || undefined,
				ts,
			});
			if (storedEvent.errorMessage) {
				publish({
					type: "model_error",
					channelKey,
					messageId: messageIdValue,
					message: storedEvent.errorMessage,
					ts,
				});
			}
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
				if (!record.silent || record.text || record.thinking) {
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
			if (record.type === "message_edit") {
				publish({
					type: "message_edited",
					channelKey: runtime.channelKey,
					messageId: record.messageId,
					text: record.text,
					ts: toUnixMs(record.ts),
				});
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

	return {
		publish,
		publishDelta,
		async appendAndPublishError(runtime, message): Promise<void> {
			await runtime.appendError(message);
			publish({ type: "error", channelKey: runtime.channelKey, code: "unknown", message });
		},
		markLocallyStreamed(messageIdValue): void {
			getOrCreateInFlight(messageIdValue).locallyStreamed = true;
		},
		subscribeRuntime,
		replay(client, channelKey, lastEventId): void {
			const events = eventsByChannel.get(channelKey) ?? [];
			replayEvents(client, events, lastEventId, () => publish({ type: "replay_window_lost", channelKey }));
		},
		registerClient(client): () => void {
			clients.add(client);
			return () => clients.delete(client);
		},
		stop(): void {
			clearInterval(inFlightGcTimer);
			for (const client of clients) client.socket.destroy();
			clients.clear();
			for (const unsubscribe of runtimeSubscriptions.values()) unsubscribe();
			runtimeSubscriptions.clear();
		},
	};
}
