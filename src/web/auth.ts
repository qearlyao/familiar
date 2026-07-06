import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { Config } from "../config/index.js";
import { isRecord } from "../util/guards.js";
import { requestAuthContext } from "./request-context.js";
import { SESSION_TTL_MS, type WebAuthDevice, type WebSessionStore } from "./session-store.js";

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 30 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

interface LoginBucket {
	count: number;
	windowStartedAt: number;
	lockedUntil?: number;
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
		try {
			cookies[name] = decodeURIComponent(valueParts.join("="));
		} catch {}
	}
	return cookies;
}

function decodeTotpSecret(secret: string): Buffer {
	const normalized = secret
		.replace(/\s/g, "")
		.replace(/={1,8}$/, "")
		.toUpperCase();
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

export function verifyTotp(secret: string, token: string, now = Date.now()): boolean {
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
	const match = header.match(/^Bearer (.+)$/i);
	return match?.[1];
}

function readSessionToken(request: IncomingMessage): string | undefined {
	return parseCookies(request.headers.cookie).familiar_session;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizeString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function tokenFingerprint(token: string): string {
	return sha256(token).slice(0, 24);
}

export function sessionCookie(sessionToken: string, secure: boolean, maxAgeMs = SESSION_TTL_MS): string {
	return [
		`familiar_session=${encodeURIComponent(sessionToken)}`,
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${Math.floor(maxAgeMs / 1000)}`,
		"Path=/api/web",
		...(secure ? ["Secure"] : []),
	].join("; ");
}

export function clearSessionCookie(secure: boolean): string {
	return [
		"familiar_session=",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=0",
		"Path=/api/web",
		...(secure ? ["Secure"] : []),
	].join("; ");
}

export function createAuth(config: Config, sessions: WebSessionStore) {
	const ipBuckets = new Map<string, LoginBucket>();
	const tokenBuckets = new Map<string, LoginBucket>();

	const hasBearer = (request: IncomingMessage): boolean => {
		if (!config.web.bearerToken) return false;
		const token = readBearerToken(request);
		return token !== undefined && safeEqual(token, config.web.bearerToken);
	};

	const checkBucket = (bucket: LoginBucket | undefined, now: number): boolean => {
		if (!bucket) return false;
		if (bucket.lockedUntil && bucket.lockedUntil > now) return true;
		if (now - bucket.windowStartedAt > LOGIN_WINDOW_MS) {
			bucket.count = 0;
			bucket.windowStartedAt = now;
			bucket.lockedUntil = undefined;
		}
		return false;
	};

	const recordFailure = (map: Map<string, LoginBucket>, key: string, now: number): void => {
		const current = map.get(key);
		const bucket =
			current && now - current.windowStartedAt <= LOGIN_WINDOW_MS ? current : { count: 0, windowStartedAt: now };
		bucket.count += 1;
		if (bucket.count >= LOGIN_MAX_FAILURES) bucket.lockedUntil = now + LOGIN_LOCKOUT_MS;
		map.set(key, bucket);
	};

	const clearFailures = (clientIp: string, token: string): void => {
		ipBuckets.delete(clientIp);
		tokenBuckets.delete(tokenFingerprint(token));
	};

	const publicPath = (method: string | undefined, pathname: string): boolean => {
		if (method === "GET" && pathname === "/api/web/auth/mode") return true;
		if (method === "POST" && pathname === "/api/web/auth/login") return config.web.authMode === "bearer";
		return false;
	};

	const authorize = async (request: IncomingMessage, pathname: string): Promise<boolean> => {
		if (publicPath(request.method, pathname)) return true;
		if (config.web.authMode === "tailscale-only") return true;
		if (hasBearer(request)) return true;
		const token = readSessionToken(request);
		return !!(await sessions.authenticateSession(token, requestAuthContext(request)));
	};

	const currentDevice = (request: IncomingMessage): Promise<WebAuthDevice | undefined> =>
		sessions.authenticateSession(readSessionToken(request), requestAuthContext(request));

	// The store slides expiresAt on activity, but the browser cookie's Max-Age is
	// fixed at issue time — re-send it so the cookie lifetime slides too.
	const refreshedSessionCookie = (request: IncomingMessage): string | undefined => {
		const token = readSessionToken(request);
		return token ? sessionCookie(token, requestAuthContext(request).secure) : undefined;
	};

	const login = async (
		request: IncomingMessage,
		body: unknown,
	): Promise<{ status: number; body: unknown; cookie?: string }> => {
		const context = requestAuthContext(request);
		const token = isRecord(body) && typeof body.token === "string" ? body.token : "";
		const fingerprint = tokenFingerprint(token);
		if (
			checkBucket(ipBuckets.get(context.clientIp), context.now) ||
			checkBucket(tokenBuckets.get(fingerprint), context.now)
		) {
			return { status: 429, body: { error: "too many login attempts" } };
		}
		if (!config.web.bearerToken || !safeEqual(token, config.web.bearerToken)) {
			recordFailure(ipBuckets, context.clientIp, context.now);
			recordFailure(tokenBuckets, fingerprint, context.now);
			return { status: 401, body: { error: "unauthorized" } };
		}
		clearFailures(context.clientIp, token);
		const { token: sessionToken, device } = await sessions.createSession({
			deviceName: isRecord(body) ? normalizeString(body.deviceName) : undefined,
			context,
		});
		return {
			status: 200,
			body: { device },
			cookie: sessionCookie(sessionToken, context.secure),
		};
	};

	const createSession = (
		request: IncomingMessage,
		deviceName?: string,
	): Promise<{ token: string; device: WebAuthDevice }> =>
		sessions.createSession({ deviceName, context: requestAuthContext(request) });

	return {
		authorize,
		currentDevice,
		refreshedSessionCookie,
		createSession,
		hasBearer,
		login,
		listDevices(request: IncomingMessage): WebAuthDevice[] {
			return sessions.listDevices(readSessionToken(request));
		},
		revokeDevice(id: string): Promise<boolean> {
			return sessions.revokeDevice(id);
		},
		revokeOthers(request: IncomingMessage): Promise<number> {
			return sessions.revokeOthers(readSessionToken(request));
		},
		logout(request: IncomingMessage): Promise<boolean> {
			return sessions.revokeCurrent(readSessionToken(request));
		},
		clearFailures,
	};
}

export type WebAuth = ReturnType<typeof createAuth>;

export { requestAuthContext } from "./request-context.js";
export { loadWebSessionStore, type WebAuthDevice, type WebSessionStore } from "./session-store.js";
