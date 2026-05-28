import type { AgentTool } from "@earendil-works/pi-agent-core";

import type { Config } from "./config.js";
import { PageCache } from "./web-tools/cache.js";
import { loadWebConfig } from "./web-tools/config.js";
import { createJinaProvider, createTinyfishProvider, parseTinyfishResponse } from "./web-tools/fetch-providers.js";
import { formatFetchContent, formatSearchResults, paginateContent } from "./web-tools/format.js";
import { resolveSearchProviders } from "./web-tools/routing.js";
import { isTransientProviderError, validateFetchUrl } from "./web-tools/safety.js";
import {
	createBraveProvider,
	createExaProvider,
	createTavilyProvider,
	normalizeDomains,
	parseBraveResults,
	parseExaResults,
	parseTavilyResults,
} from "./web-tools/search-providers.js";
import {
	FETCH_DEFAULT_MAX_CHARS,
	type FetchProvider,
	type LoadedConfig,
	type SearchCapability,
	type SearchProvider,
	type SearchProviderName,
	WEB_UNTRUSTED_PREFIX,
	webFetchSchema,
	webSearchSchema,
} from "./web-tools/types.js";

const pageCache = new PageCache();

function makeSearchTool(config: LoadedConfig): AgentTool<typeof webSearchSchema> {
	const providers: Partial<Record<SearchProviderName, SearchProvider>> = {};
	if (config.apiKeys.BRAVE_API_KEY) providers.brave = createBraveProvider(config.apiKeys.BRAVE_API_KEY);
	if (config.apiKeys.TAVILY_API_KEY) providers.tavily = createTavilyProvider(config.apiKeys.TAVILY_API_KEY);
	if (config.apiKeys.EXA_API_KEY) providers.exa = createExaProvider(config.apiKeys.EXA_API_KEY);

	return {
		name: "search_web",
		label: "Web Search",
		description:
			"look something up on the open web. returns titles, urls, snippets, and dates when present. depth=thorough swaps brevity for inline excerpts.",
		parameters: webSearchSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			const activeSignal = signal ?? new AbortController().signal;
			if (Object.keys(providers).length === 0) {
				throw new Error("No search provider configured. Set BRAVE_API_KEY, TAVILY_API_KEY, or EXA_API_KEY.");
			}

			const domains = normalizeDomains(params.domains);
			const depth = params.depth ?? "basic";
			const providersInOrder = resolveSearchProviders({ depth, freshness: params.freshness, domains }, providers);
			if (providersInOrder.length === 0) {
				throw new Error("No search provider available for this request.");
			}

			let lastError: Error | undefined;
			for (const provider of providersInOrder) {
				if (activeSignal.aborted) throw new Error("Search aborted.");
				onUpdate?.({ content: [{ type: "text", text: `Searching via ${provider.name}...` }], details: undefined });
				try {
					const response = await provider.search({
						query: params.query,
						maxResults: params.maxResults ?? 5,
						includeContent: depth === "thorough",
						freshness: params.freshness,
						domains,
						signal: activeSignal,
					});
					return {
						content: [
							{
								type: "text",
								text: formatSearchResults({
									results: response.results,
									provider: provider.name,
									requestedDepth: depth,
									servedDepth: depth,
									freshness: params.freshness,
									domains,
									appliedFilters: response.appliedFilters,
									notes: response.notes,
								}),
							},
						],
						details: {
							provider: provider.name,
							requestedDepth: depth,
							servedDepth: depth,
							degraded: false,
							freshness: params.freshness ?? null,
							domains: domains ?? [],
							resultCount: response.results.length,
						},
					};
				} catch (error) {
					lastError = error instanceof Error ? error : new Error(String(error));
					if (!isTransientProviderError(lastError)) throw lastError;
				}
			}

			throw new Error(`All search providers failed for this request. ${lastError?.message ?? ""}`.trim());
		},
	};
}

function makeFetchTool(config: LoadedConfig): AgentTool<typeof webFetchSchema> {
	const providers = createFetchProviders(config);
	return {
		name: "fetch_web",
		label: "Web Fetch",
		description: "pull a webpage down as clean markdown.",
		parameters: webFetchSchema,
		async execute(_toolCallId, params, signal) {
			const activeSignal = signal ?? new AbortController().signal;
			const url = validateFetchUrl(params.url);
			const offset = params.offset ?? 0;
			const maxChars = params.maxChars ?? FETCH_DEFAULT_MAX_CHARS;
			const cached = pageCache.get(url);

			let providerName = cached?.provider ?? providers[0]?.name ?? "jina";
			let content = cached?.content;
			if (!content) {
				let lastError: Error | undefined;
				for (const provider of providers) {
					try {
						content = await provider.fetch(url, activeSignal);
						providerName = provider.name;
						pageCache.set(url, content, provider.name);
						break;
					} catch (error) {
						lastError = error instanceof Error ? error : new Error(String(error));
						if (!isTransientProviderError(lastError)) throw lastError;
					}
				}
				if (!content)
					throw new Error(`All fetch providers failed for this request. ${lastError?.message ?? ""}`.trim());
			}

			const chunk = paginateContent(content, offset, maxChars);
			return {
				content: [
					{
						type: "text",
						text: formatFetchContent(url, providerName, chunk),
					},
				],
				details: {
					provider: providerName,
					url,
					totalChars: content.length,
					offset: chunk.offset,
					returnedChars: chunk.returnedChars,
					nextOffset: chunk.nextOffset,
					hasMore: chunk.hasMore,
				},
			};
		},
	};
}

function createFetchProviders(config: LoadedConfig): FetchProvider[] {
	const providers: FetchProvider[] = [];
	if (config.apiKeys.TINYFISH_API_KEY) providers.push(createTinyfishProvider(config.apiKeys.TINYFISH_API_KEY));
	providers.push(createJinaProvider(config.apiKeys.JINA_API_KEY));
	return providers;
}

function createTestSearchProvider(name: SearchProviderName, capabilities: SearchCapability[]): SearchProvider {
	return {
		name,
		capabilities: new Set(capabilities),
		async search() {
			return { results: [] };
		},
	};
}

export function webContentWarning(): string {
	return WEB_UNTRUSTED_PREFIX;
}

export function createWebTools(_config: Config): AgentTool<any>[] {
	const loaded = loadWebConfig();
	return [makeSearchTool(loaded), makeFetchTool(loaded)];
}

export const __webToolsTest = {
	PageCache,
	createWebTools,
	createTestSearchProvider,
	createFetchProviders,
	formatFetchContent,
	formatSearchResults,
	normalizeDomains,
	parseBraveResults,
	parseExaResults,
	parseTavilyResults,
	parseTinyfishResponse,
	paginateContent,
	resolveSearchProviders,
	validateFetchUrl,
};
