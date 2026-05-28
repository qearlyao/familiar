import type { SearchDepth, SearchFreshness, SearchProvider, SearchProviderName } from "./types.js";

export function searchProviderOrder(depth: SearchDepth, args: { domains?: string[] }): SearchProviderName[] {
	if (depth === "thorough") return ["tavily", "exa", "brave"];
	if (args.domains?.length) return ["tavily", "exa", "brave"];
	return ["brave", "tavily", "exa"];
}

export function canServe(provider: SearchProvider, depth: SearchDepth): boolean {
	if (depth === "thorough") return provider.capabilities.has("search") && provider.capabilities.has("content");
	return provider.capabilities.has("search");
}

export function canServeSearchArgs(
	provider: SearchProvider,
	args: {
		depth: SearchDepth;
		domains?: string[];
	},
): boolean {
	if (!canServe(provider, args.depth)) return false;
	if ((args.domains?.length ?? 0) > 1 && !provider.capabilities.has("domainFilter")) return false;
	return true;
}

export function resolveSearchProviders(
	args: {
		depth: SearchDepth;
		freshness?: SearchFreshness;
		domains?: string[];
	},
	searchProviders: Partial<Record<SearchProviderName, SearchProvider>>,
): SearchProvider[] {
	const providers: SearchProvider[] = [];
	for (const name of searchProviderOrder(args.depth, args)) {
		const candidate = searchProviders[name];
		if (candidate && canServeSearchArgs(candidate, args) && !providers.includes(candidate)) {
			providers.push(candidate);
		}
	}
	return providers;
}
