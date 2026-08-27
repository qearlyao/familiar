import { resolve } from "node:path";

import type { Model } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { Config } from "../config/index.js";
import { describeModelAuth, resolveProviderSetting } from "./index.js";

function apiKeyEnvEntries(config: Config, provider: string): Array<[string, string]> {
	return Object.entries(config.models.apiKeyEnvs).filter(
		([key]) => key === provider || key.startsWith(`${provider}/`),
	);
}

function providerApiKeyReference(config: Config, provider: string): string | undefined {
	const entries = apiKeyEnvEntries(config, provider);
	const envName = entries.find(([key]) => key === provider)?.[1] ?? entries[0]?.[1];
	return envName ? `$${envName}` : undefined;
}

export async function createModelRuntime(config: Config): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		authPath: resolve(config.workspacePath, "auth.json"),
	});

	const providerIds = new Set([
		...Object.keys(config.models.providers),
		...Object.keys(config.models.apiKeyEnvs).map((key) => key.split("/", 1)[0]!),
	]);
	for (const provider of providerIds) {
		const definition = config.models.providers[provider];
		const apiKey = providerApiKeyReference(config, provider);
		if (!definition && !apiKey) continue;
		const baseUrl = config.models.baseUrls[provider];
		runtime.registerProvider(provider, {
			...(definition?.api ? { api: definition.api as Model<any>["api"] } : {}),
			...(baseUrl ? { baseUrl } : {}),
			...(apiKey ? { apiKey } : {}),
		});
	}
	return runtime;
}

export async function assertModelCanAuthenticateWithRuntime(
	config: Config,
	runtime: ModelRuntime,
	model: Model<any>,
): Promise<void> {
	const auth = await runtime.getAuth(model, { env: modelRuntimeEnv(config, model) });
	if (auth) return;
	throw new Error(`Missing API key for ${model.provider}/${model.id}: ${describeModelAuth(config, model)}`);
}

export function modelRuntimeEnv(
	config: Config,
	model: Model<any>,
	configuredEnv = resolveProviderSetting(config.models.apiKeyEnvs, model.provider, model.id),
): Record<string, string> | undefined {
	if (!configuredEnv) return undefined;
	const value = process.env[configuredEnv];
	if (value === undefined) return undefined;
	const runtimeEnv = providerApiKeyReference(config, model.provider)?.slice(1);
	return runtimeEnv ? { [runtimeEnv]: value } : undefined;
}
