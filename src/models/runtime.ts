import { resolve } from "node:path";
import type { StreamOptions } from "@earendil-works/pi-ai";
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
		modelsPath: resolve(config.workspacePath, "models.json"),
		modelsStorePath: resolve(config.workspace.dataDir, "models-store.json"),
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
	const anthropic = runtime.getProvider("anthropic");
	if (!anthropic) throw new Error("Missing built-in Anthropic provider");
	runtime.registerNativeProvider({
		...anthropic,
		stream: (model, context, options) => anthropic.stream(model, context, claudeOAuthOptions(options)),
		streamSimple: (model, context, options) => anthropic.streamSimple(model, context, claudeOAuthOptions(options)),
	});
	return runtime;
}

function claudeOAuthOptions<T extends StreamOptions>(options: T | undefined): T | undefined {
	if (!options?.apiKey?.includes("sk-ant-oat")) return options;
	// pi 0.86 sends 2.1.251; Opus 5.5 requires Claude Code 2.1.280 or newer.
	return { ...options, headers: { ...options.headers, "user-agent": "claude-cli/2.1.280" } };
}

export async function refreshModelCatalogs(runtime: ModelRuntime): Promise<void> {
	const result = await runtime.refresh({ allowNetwork: true, force: true, signal: AbortSignal.timeout(15_000) });
	if (result.aborted) throw new Error("Model catalog refresh timed out");
	if (result.errors.size) {
		throw new Error(
			`Model catalog refresh failed: ${Array.from(result.errors, ([provider, error]) => `${provider}: ${error.message}`).join("; ")}`,
		);
	}
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
