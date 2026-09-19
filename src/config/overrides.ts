import { jsonSettingsStore } from "../util/fs.js";
import { isRecord } from "../util/guards.js";

const store = jsonSettingsStore(
	"config-overrides.json",
	(raw): Record<string, unknown> => (isRecord(raw) ? { ...raw } : {}),
);

export const setConfigOverridesPath = store.setDataDir;

export function loadConfigOverrides(): Record<string, unknown> {
	return { ...store.load() };
}

export function setConfigOverride(key: string, value: unknown): Promise<void> {
	return store.save({ ...store.load(), [key]: value });
}

export async function clearConfigOverride(key: string): Promise<void> {
	const current = store.load();
	if (!(key in current)) return;
	const next = { ...current };
	delete next[key];
	await store.save(next);
}
