import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { Config } from "./config.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface SessionRecord {
	expiresAt: number;
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

export function createAuth(config: Config) {
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

export function sessionCookie(sessionId: string): string {
	return `familiar_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
		SESSION_TTL_MS / 1000,
	)}; Path=/api/web`;
}
