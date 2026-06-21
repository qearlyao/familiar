import { isAbsolute, resolve } from "node:path";
import { isRecord } from "../util/guards.js";

export function resolveWorkspacePath(workspacePath: string, filePath: string): string {
	return isAbsolute(filePath) ? filePath : resolve(workspacePath, filePath);
}

export function readString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Missing required config value: ${path}`);
	}
	return value;
}

export function readOptionalString(value: unknown, fallback: string): string {
	if (value === undefined) return fallback;
	if (typeof value !== "string") throw new Error(`Config value must be a string: ${JSON.stringify(value)}`);
	return value.trim() !== "" ? value : fallback;
}

export function readOptionalConfigString(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`Config value ${path} must be a string`);
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

export function readConfigString(value: unknown, fallback: string, path: string): string {
	const read = readOptionalConfigString(value, path);
	return read ?? fallback;
}

export function readStringArray(value: unknown, path: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`Config value must be a string array: ${path}`);
	}
	return value;
}

export function readStringRecord(value: unknown, path: string): Record<string, string> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Config value must be a string map: ${path}`);
	}
	const entries = Object.entries(value);
	for (const [key, child] of entries) {
		if (typeof child !== "string") throw new Error(`Config value must be a string map: ${path}.${key}`);
	}
	return Object.fromEntries(entries) as Record<string, string>;
}

export function readConfigTable(value: unknown, path: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`Config value ${path} must be a table`);
	return value;
}

export function readConfigTableArray(value: unknown, path: string): Record<string, unknown>[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
		throw new Error(`Config value ${path} must be an array of tables`);
	}
	return value;
}

export function readBoolean(value: unknown, fallback: boolean, path: string): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	throw new Error(`Config value ${path} must be a boolean`);
}

export function readInteger(value: unknown, fallback: number, path: string, min = 0): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
		throw new Error(`Config value ${path} must be an integer >= ${min}`);
	}
	return value;
}

export function readNumberInRange(value: unknown, fallback: number, path: string, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
		throw new Error(`Config value ${path} must be a number between ${min} and ${max}`);
	}
	return value;
}

export function readFraction(value: unknown, fallback: number, path: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
		throw new Error(`Config value ${path} must be a number > 0 and <= 1`);
	}
	return value;
}

export function readPositiveNumber(value: unknown, fallback: number, path: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Config value ${path} must be a positive number`);
	}
	return value;
}

export function readOptionalInteger(value: unknown, path: string, min = 0): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
		throw new Error(`Config value ${path} must be an integer >= ${min}`);
	}
	return value;
}

export function readIntegerInRange(value: unknown, fallback: number, path: string, min: number, max: number): number {
	const read = readInteger(value, fallback, path, min);
	if (read > max) throw new Error(`Config value ${path} must be an integer <= ${max}`);
	return read;
}

export function readOptionalIntegerInRange(value: unknown, path: string, min: number, max: number): number | undefined {
	const read = readOptionalInteger(value, path, min);
	if (read !== undefined && read > max) throw new Error(`Config value ${path} must be an integer <= ${max}`);
	return read;
}

export function assertKnownKeys(value: Record<string, unknown>, path: string, knownKeys: readonly string[]): void {
	const known = new Set(knownKeys);
	for (const key of Object.keys(value)) {
		if (!known.has(key)) throw new Error(`Unknown config value: ${path}.${key}`);
	}
}
