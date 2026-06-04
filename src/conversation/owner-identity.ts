import { resolve } from "node:path";

import { atomicWriteJson, readFileOrNull } from "../util/fs.js";
import { isRecord } from "../util/guards.js";

export interface OwnerIdentity {
	botUserId: string;
	dmChannelId: string;
}

export function ownerIdentityPath(dataDir: string): string {
	return resolve(dataDir, "owner-identity.json");
}

export async function loadOwnerIdentity(dataDir: string): Promise<OwnerIdentity | null> {
	const raw = await readFileOrNull(ownerIdentityPath(dataDir), "utf8");
	if (raw === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!isRecord(parsed)) return null;
	const { botUserId, dmChannelId } = parsed;
	if (typeof botUserId !== "string" || botUserId.length === 0) return null;
	if (typeof dmChannelId !== "string" || dmChannelId.length === 0) return null;
	return { botUserId, dmChannelId };
}

export async function saveOwnerIdentity(dataDir: string, identity: OwnerIdentity): Promise<void> {
	await atomicWriteJson(ownerIdentityPath(dataDir), identity);
}
