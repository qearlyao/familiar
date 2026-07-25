import type { LoadedConfig } from "./types.js";

export function readEnvKey(name: keyof LoadedConfig["apiKeys"]): string | undefined {
	const value = process.env[name];
	return value?.trim() ? value.trim() : undefined;
}

export function loadWebConfig(): LoadedConfig {
	return {
		apiKeys: {
			BRAVE_API_KEY: readEnvKey("BRAVE_API_KEY"),
			TAVILY_API_KEY: readEnvKey("TAVILY_API_KEY"),
			EXA_API_KEY: readEnvKey("EXA_API_KEY"),
			JINA_API_KEY: readEnvKey("JINA_API_KEY"),
			TINYFISH_API_KEY: readEnvKey("TINYFISH_API_KEY"),
		},
	};
}
