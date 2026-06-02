import type { IncomingMessage } from "node:http";

export interface RequestAuthContext {
	clientIp: string;
	userAgent?: string;
	secure: boolean;
	now: number;
}

function normalizeRemoteAddress(address: string | undefined): string | undefined {
	if (!address) return undefined;
	if (address.startsWith("::ffff:")) return address.slice("::ffff:".length);
	return address;
}

function isLoopbackAddress(address: string | undefined): boolean {
	const normalized = normalizeRemoteAddress(address);
	return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

export function requestAuthContext(request: IncomingMessage, now = Date.now()): RequestAuthContext {
	const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress);
	const trustedProxy = isLoopbackAddress(remoteAddress);
	const forwardedFor = trustedProxy ? firstHeaderValue(request.headers["x-forwarded-for"]) : undefined;
	const forwardedProto = trustedProxy ? firstHeaderValue(request.headers["x-forwarded-proto"]) : undefined;
	const clientIp = forwardedFor?.split(",")[0]?.trim() || remoteAddress || "unknown";
	const socket = request.socket as typeof request.socket & { encrypted?: boolean };
	const secure = forwardedProto?.split(",")[0]?.trim().toLowerCase() === "https" || socket.encrypted === true;
	const userAgent = firstHeaderValue(request.headers["user-agent"]);
	return { clientIp, secure, now, ...(userAgent ? { userAgent } : {}) };
}
