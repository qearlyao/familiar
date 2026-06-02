import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

import type { Config } from "../config.js";
import { atomicWriteJson, createWriteQueue, readFileOrNull } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import type { RequestAuthContext } from "./request-context.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

interface StoredWebSession {
	id: string;
	tokenHash: string;
	deviceName: string;
	createdAt: string;
	lastSeenAt: string;
	expiresAt: string;
	lastIp?: string;
	userAgent?: string;
	revokedAt?: string;
}

interface WebSessionsFile {
	version: 1;
	sessions: StoredWebSession[];
}

export interface WebAuthDevice {
	id: string;
	deviceName: string;
	createdAt: string;
	lastSeenAt: string;
	expiresAt: string;
	lastIp?: string;
	userAgent?: string;
	current?: boolean;
}

export interface WebSessionStore {
	path: string;
	createSession(input: {
		deviceName?: string;
		context: RequestAuthContext;
	}): Promise<{ token: string; device: WebAuthDevice }>;
	authenticateSession(token: string | undefined, context: RequestAuthContext): Promise<WebAuthDevice | undefined>;
	currentDevice(token: string | undefined): WebAuthDevice | undefined;
	listDevices(currentToken?: string): WebAuthDevice[];
	revokeDevice(id: string): Promise<boolean>;
	revokeCurrent(token: string | undefined): Promise<boolean>;
	revokeOthers(token: string | undefined): Promise<number>;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizeString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeDeviceName(value: unknown, fallback: string): string {
	const name = normalizeString(value) ?? fallback;
	return name.slice(0, 80);
}

function deviceDto(session: StoredWebSession, current = false): WebAuthDevice {
	return {
		id: session.id,
		deviceName: session.deviceName,
		createdAt: session.createdAt,
		lastSeenAt: session.lastSeenAt,
		expiresAt: session.expiresAt,
		...(session.lastIp ? { lastIp: session.lastIp } : {}),
		...(session.userAgent ? { userAgent: session.userAgent } : {}),
		...(current ? { current: true } : {}),
	};
}

function isActive(session: StoredWebSession, now: number): boolean {
	return !session.revokedAt && Date.parse(session.expiresAt) > now;
}

function normalizeSession(value: unknown): StoredWebSession | undefined {
	if (!isRecord(value)) return undefined;
	const id = normalizeString(value.id);
	const tokenHash = normalizeString(value.tokenHash);
	const deviceName = normalizeString(value.deviceName);
	const createdAt = normalizeString(value.createdAt);
	const lastSeenAt = normalizeString(value.lastSeenAt);
	const expiresAt = normalizeString(value.expiresAt);
	if (!id || !tokenHash || !deviceName || !createdAt || !lastSeenAt || !expiresAt) return undefined;
	return {
		id,
		tokenHash,
		deviceName,
		createdAt,
		lastSeenAt,
		expiresAt,
		lastIp: normalizeString(value.lastIp),
		userAgent: normalizeString(value.userAgent),
		revokedAt: normalizeString(value.revokedAt),
	};
}

function normalizeSessionsFile(value: unknown, now: number): WebSessionsFile {
	if (!isRecord(value) || !Array.isArray(value.sessions)) return { version: 1, sessions: [] };
	return {
		version: 1,
		sessions: value.sessions
			.map(normalizeSession)
			.filter((session): session is StoredWebSession => !!session && isActive(session, now)),
	};
}

async function readSessionsFile(path: string, now: number): Promise<WebSessionsFile> {
	const raw = await readFileOrNull(path, "utf8");
	return raw === null ? { version: 1, sessions: [] } : normalizeSessionsFile(JSON.parse(raw) as unknown, now);
}

export async function loadWebSessionStore(config: Config, now = Date.now()): Promise<WebSessionStore> {
	const path = resolve(config.workspace.dataDir, "settings", "web-sessions.json");
	let file = await readSessionsFile(path, now);
	const enqueueWrite = createWriteQueue("web sessions");
	const enqueuePersist = (): Promise<void> => enqueueWrite(() => atomicWriteJson(path, file));

	const findByToken = (token: string | undefined, now: number): StoredWebSession | undefined => {
		if (!token) return undefined;
		const tokenHash = sha256(token);
		return file.sessions.find((session) => session.tokenHash === tokenHash && isActive(session, now));
	};

	return {
		path,
		async createSession(input): Promise<{ token: string; device: WebAuthDevice }> {
			const now = input.context.now;
			const ts = new Date(now).toISOString();
			const token = randomBytes(32).toString("base64url");
			const session: StoredWebSession = {
				id: randomBytes(12).toString("base64url"),
				tokenHash: sha256(token),
				deviceName: normalizeDeviceName(input.deviceName, "browser"),
				createdAt: ts,
				lastSeenAt: ts,
				expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
				lastIp: input.context.clientIp,
				userAgent: input.context.userAgent,
			};
			file = { version: 1, sessions: [...file.sessions.filter((item) => isActive(item, now)), session] };
			await enqueuePersist();
			return { token, device: deviceDto(session, true) };
		},
		async authenticateSession(token, context): Promise<WebAuthDevice | undefined> {
			const session = findByToken(token, context.now);
			if (!session) return undefined;
			const touchedAt = Date.parse(session.lastSeenAt);
			const nextExpiresAt = new Date(context.now + SESSION_TTL_MS).toISOString();
			const changed =
				context.now - touchedAt >= SESSION_TOUCH_INTERVAL_MS ||
				session.lastIp !== context.clientIp ||
				session.userAgent !== context.userAgent;
			if (changed) {
				session.lastSeenAt = new Date(context.now).toISOString();
				session.expiresAt = nextExpiresAt;
				session.lastIp = context.clientIp;
				session.userAgent = context.userAgent;
				await enqueuePersist();
			}
			return deviceDto(session, true);
		},
		currentDevice(token): WebAuthDevice | undefined {
			const session = findByToken(token, Date.now());
			return session ? deviceDto(session, true) : undefined;
		},
		listDevices(currentToken): WebAuthDevice[] {
			const now = Date.now();
			const currentHash = currentToken ? sha256(currentToken) : undefined;
			file = { version: 1, sessions: file.sessions.filter((session) => isActive(session, now)) };
			return file.sessions.map((session) => deviceDto(session, session.tokenHash === currentHash));
		},
		async revokeDevice(id): Promise<boolean> {
			const session = file.sessions.find((item) => item.id === id && !item.revokedAt);
			if (!session) return false;
			session.revokedAt = new Date().toISOString();
			await enqueuePersist();
			return true;
		},
		async revokeCurrent(token): Promise<boolean> {
			const session = findByToken(token, Date.now());
			if (!session) return false;
			session.revokedAt = new Date().toISOString();
			await enqueuePersist();
			return true;
		},
		async revokeOthers(token): Promise<number> {
			const session = findByToken(token, Date.now());
			if (!session) return 0;
			const now = new Date().toISOString();
			let revoked = 0;
			for (const item of file.sessions) {
				if (item.tokenHash === session.tokenHash || item.revokedAt) continue;
				item.revokedAt = now;
				revoked += 1;
			}
			if (revoked > 0) await enqueuePersist();
			return revoked;
		},
	};
}
