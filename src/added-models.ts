import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { atomicWriteJson, createWriteQueue, isEnoent } from "./util/fs.js";

let addedModelsPath = resolve(process.cwd(), "data", "settings", "added-models.json");
let loaded = false;
let modelsCache: string[] = [];
const enqueueWrite = createWriteQueue("added models");

interface AddedModelsFile {
	models: string[];
}

function normalizeModels(value: unknown): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const input = value as Record<string, unknown>;
	const modelsInput = Array.isArray(input.models) ? input.models : [];
	const models: string[] = [];
	const seen = new Set<string>();
	for (const entry of modelsInput) {
		if (typeof entry !== "string") continue;
		const model = entry.trim();
		if (!model || seen.has(model)) continue;
		seen.add(model);
		models.push(model);
	}
	return models;
}

function readAddedModelsFile(path: string): string[] {
	try {
		const raw = readFileSync(path, "utf8");
		return normalizeModels(JSON.parse(raw) as unknown);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

export function setAddedModelsPath(dataDir: string): void {
	addedModelsPath = resolve(dataDir, "settings", "added-models.json");
	loaded = false;
	modelsCache = [];
}

export function loadAddedModels(): string[] {
	if (!loaded) {
		modelsCache = readAddedModelsFile(addedModelsPath);
		loaded = true;
	}
	return [...modelsCache];
}

export async function saveAddedModels(models: string[]): Promise<void> {
	const nextModels = normalizeModels({ models });
	modelsCache = nextModels;
	loaded = true;
	const file: AddedModelsFile = { models: nextModels };
	await enqueueWrite(() => atomicWriteJson(addedModelsPath, file));
}

export async function addModel(model: string): Promise<string[]> {
	const current = loadAddedModels();
	if (current.includes(model)) return current;
	const next = [...current, model];
	await saveAddedModels(next);
	return next;
}

export async function removeModel(model: string): Promise<string[]> {
	const current = loadAddedModels();
	if (!current.includes(model)) throw new Error("model is not user-added");
	const next = current.filter((entry) => entry !== model);
	await saveAddedModels(next);
	return next;
}
