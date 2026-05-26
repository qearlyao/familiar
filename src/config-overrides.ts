import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { atomicWriteJson, createWriteQueue, isEnoent } from "./util/fs.js";

let overridesPath = resolve(process.cwd(), "data", "settings", "config-overrides.json");
let loaded = false;
let cache: Record<string, unknown> = {};
const enqueueWrite = createWriteQueue("config overrides");

function normalize(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const input = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(input)) {
		if (typeof key !== "string") continue;
		out[key] = v;
	}
	return out;
}

function read(path: string): Record<string, unknown> {
	try {
		const raw = readFileSync(path, "utf8");
		return normalize(JSON.parse(raw) as unknown);
	} catch (error) {
		if (isEnoent(error)) return {};
		throw error;
	}
}

export function setConfigOverridesPath(dataDir: string): void {
	overridesPath = resolve(dataDir, "settings", "config-overrides.json");
	loaded = false;
	cache = {};
}

export function loadConfigOverrides(): Record<string, unknown> {
	if (!loaded) {
		cache = read(overridesPath);
		loaded = true;
	}
	return { ...cache };
}

async function save(next: Record<string, unknown>): Promise<void> {
	cache = next;
	loaded = true;
	await enqueueWrite(() => atomicWriteJson(overridesPath, next));
}

export async function setConfigOverride(key: string, value: unknown): Promise<void> {
	const next = { ...loadConfigOverrides(), [key]: value };
	await save(next);
}

export async function clearConfigOverride(key: string): Promise<void> {
	const current = loadConfigOverrides();
	if (!(key in current)) return;
	const next = { ...current };
	delete next[key];
	await save(next);
}
