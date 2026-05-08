import type { Server } from "node:http";

export const WEB_USER_NAME = "you";
export const EVENT_REPLAY_LIMIT = 1000;

export type WebAttachment = {
	id: string;
	name: string;
	mimeType?: string;
	size?: number;
	url?: string;
};

export type WebToolEvent = {
	id: string;
	name: string;
	status: "pending" | "running" | "completed" | "error";
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
	error?: string;
	startedAt?: number;
	updatedAt?: number;
	completedAt?: number;
};

export type WebUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

export type WebMessagePart =
	| { type: "text"; id: string; text: string }
	| { type: "tool"; id: string; tool: WebToolEvent };

export type WebMessage = {
	id: string;
	role: "user" | "assistant" | "system";
	who: string;
	text: string;
	attachments?: WebAttachment[];
	thinking?: string;
	thinkingMs?: number;
	tools?: WebToolEvent[];
	parts?: WebMessagePart[];
	usage?: WebUsage;
	ts: number;
};

export type WebStreamEvent =
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
			attachments?: WebAttachment[];
			usage?: WebUsage;
	  }
	| {
			type: "tool_event";
			eventId: string;
			ts: number;
			channelKey?: string;
			messageId: string;
			tool: WebToolEvent;
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

export interface WebDaemon {
	server: Server;
	stop(): Promise<void>;
}

export type WebPublishEvent = WebStreamEvent extends infer Event
	? Event extends { eventId: string; ts: number }
		? Omit<Event, "eventId" | "ts"> & { ts?: number }
		: never
	: never;
