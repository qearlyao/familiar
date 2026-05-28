import { randomUUID } from "node:crypto";

export function toUnixMs(ts: string | undefined): number {
	const parsed = ts ? Date.parse(ts) : NaN;
	return Number.isFinite(parsed) ? parsed : Date.now();
}

export function eventId(): string {
	return `evt_${randomUUID()}`;
}

export function messageId(prefix = "msg"): string {
	return `${prefix}_${randomUUID()}`;
}
