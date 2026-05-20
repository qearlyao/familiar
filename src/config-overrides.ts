import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

let overridesPath = resolve(process.cwd(), "data", "settings", "config-overrides.json");
let loaded = false;
let cache: Record<string, unknown> = {};
let writeQueue = Promise.resolve();

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
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
}

async function persist(path: string, values: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(values, null, 2)}\n`, "utf8");
	await rename(tmpPath, path);
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
	const path = overridesPath;
	const run = writeQueue.then(
		() => persist(path, next),
		() => persist(path, next),
	);
	writeQueue = run.then(
		() => undefined,
		() => undefined,
	);
	await run;
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
