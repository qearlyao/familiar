import { jsonSettingsStore } from "../util/fs.js";

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

const store = jsonSettingsStore("added-models.json", (raw): AddedModelsFile => ({ models: normalizeModels(raw) }));

export const setAddedModelsPath = store.setDataDir;

export function loadAddedModels(): string[] {
	return [...store.load().models];
}

export function saveAddedModels(models: string[]): Promise<void> {
	return store.save({ models: normalizeModels({ models }) });
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
