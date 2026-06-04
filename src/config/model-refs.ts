import { parseModelRef } from "../models/index.js";

export function parseProviderModelRef(value: string, path: string): { provider: string; modelId: string; key: string } {
	const parsed = maybeParseProviderModelRef(value);
	if (parsed) return parsed;
	throw new Error(`Config value ${path} must be a provider/model id`);
}

export function maybeParseProviderModelRef(
	value: string,
): { provider: string; modelId: string; key: string } | undefined {
	const parsed = parseModelRef(value);
	return parsed ? { provider: parsed.provider, modelId: parsed.id, key: parsed.key } : undefined;
}
