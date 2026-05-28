import { createHash } from "node:crypto";

import { isRecord } from "../../../util/guards.js";

export function jsonOrNull(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return JSON.stringify(value);
}

export function parseJsonObject(value: string | null): Record<string, unknown> | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function parseJsonArray<T>(value: string | null): T[] | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? (parsed as T[]) : null;
	} catch {
		return null;
	}
}

export function stableHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sourceRecordIdToString(value: number | string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return String(value);
}
