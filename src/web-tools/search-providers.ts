import { fetchJson } from "./http.js";
import {
	MAX_RESPONSE_BYTES,
	ProviderError,
	SEARCH_TIMEOUT_BASIC_MS,
	SEARCH_TIMEOUT_THOROUGH_MS,
	type SearchCapability,
	type SearchFreshness,
	type SearchProvider,
	type SearchResponse,
	type SearchResult,
} from "./types.js";
import { hostnameFromUrl, isPlainObject, normalizeIsoDate, truncateSnippet } from "./util.js";

export function normalizeDomains(domains: string[] | undefined): string[] | undefined {
	if (!domains?.length) return undefined;
	const normalized = new Set<string>();
	for (const value of domains) {
		const trimmed = value.trim().toLowerCase();
		if (!trimmed) continue;
		if (trimmed.includes("://") || trimmed.includes("/") || trimmed.includes(":")) {
			throw new Error(`Invalid domain filter "${value}". Use bare hostnames only.`);
		}
		if (!/^[a-z0-9.-]+$/.test(trimmed) || trimmed.startsWith(".") || trimmed.endsWith(".")) {
			throw new Error(`Invalid domain filter "${value}". Use bare hostnames only.`);
		}
		normalized.add(trimmed);
	}
	return normalized.size > 0 ? [...normalized] : undefined;
}

export function addSiteConstraint(query: string, domain: string): string {
	return `${query} site:${domain}`;
}

export function freshnessToBrave(value: SearchFreshness | undefined): string | undefined {
	switch (value) {
		case "day":
			return "pd";
		case "week":
			return "pw";
		case "month":
			return "pm";
		case "year":
			return "py";
		default:
			return undefined;
	}
}

export function freshnessToPublishedDate(freshness: SearchFreshness | undefined): string | undefined {
	if (!freshness) return undefined;
	const now = new Date();
	const daysBack = { day: 1, week: 7, month: 30, year: 365 }[freshness];
	now.setUTCDate(now.getUTCDate() - daysBack);
	now.setUTCHours(0, 0, 0, 0);
	return now.toISOString();
}

export function parseBraveResults(payload: unknown): SearchResult[] {
	if (!isPlainObject(payload) || !isPlainObject(payload.web) || !Array.isArray(payload.web.results)) {
		throw new ProviderError("brave", "Brave returned unexpected response shape.", false);
	}
	const results: SearchResult[] = [];
	for (const raw of payload.web.results) {
		if (!isPlainObject(raw)) continue;
		const title = typeof raw.title === "string" ? raw.title.trim() : "";
		const url = typeof raw.url === "string" ? raw.url.trim() : "";
		if (!title || !url) continue;
		const snippet =
			typeof raw.description === "string" ? raw.description : typeof raw.snippet === "string" ? raw.snippet : "";
		results.push({
			title,
			url,
			snippet: truncateSnippet(snippet, 500),
			sourceDomain: hostnameFromUrl(url),
			publishedAt: normalizeIsoDate(
				typeof raw.publishedDate === "string"
					? raw.publishedDate
					: typeof raw.publishedAt === "string"
						? raw.publishedAt
						: typeof raw.date === "string"
							? raw.date
							: undefined,
			),
		});
	}
	return results;
}

export function parseExaResults(payload: unknown, includeContent: boolean): SearchResult[] {
	if (!isPlainObject(payload) || !Array.isArray(payload.results)) {
		throw new ProviderError("exa", "Exa returned unexpected response shape.", false);
	}
	const results: SearchResult[] = [];
	for (const raw of payload.results) {
		if (!isPlainObject(raw)) continue;
		const title = typeof raw.title === "string" ? raw.title.trim() : "";
		const url = typeof raw.url === "string" ? raw.url.trim() : "";
		if (!title || !url) continue;
		const result: SearchResult = {
			title,
			url,
			snippet: truncateSnippet(
				typeof raw.text === "string"
					? raw.text
					: Array.isArray(raw.highlights)
						? raw.highlights.filter((item) => typeof item === "string").join(" ")
						: "",
				300,
			),
			sourceDomain: hostnameFromUrl(url),
			publishedAt: normalizeIsoDate(typeof raw.publishedDate === "string" ? raw.publishedDate : undefined),
		};
		if (includeContent && typeof raw.text === "string" && raw.text.trim()) {
			result.content = raw.text.trim();
		}
		results.push(result);
	}
	return results;
}

export function parseTavilyResults(payload: unknown, includeContent: boolean): SearchResult[] {
	if (!isPlainObject(payload) || !Array.isArray(payload.results)) {
		throw new ProviderError("tavily", "Tavily returned unexpected response shape.", false);
	}
	const results: SearchResult[] = [];
	for (const raw of payload.results) {
		if (!isPlainObject(raw)) continue;
		const title = typeof raw.title === "string" ? raw.title.trim() : "";
		const url = typeof raw.url === "string" ? raw.url.trim() : "";
		if (!title || !url) continue;
		const snippetSource =
			typeof raw.content === "string" && raw.content.trim()
				? raw.content
				: typeof raw.raw_content === "string" && raw.raw_content.trim()
					? raw.raw_content
					: "";
		const result: SearchResult = {
			title,
			url,
			snippet: truncateSnippet(snippetSource, 320) || "[No snippet available]",
			sourceDomain: hostnameFromUrl(url),
			publishedAt: normalizeIsoDate(typeof raw.published_date === "string" ? raw.published_date : undefined),
		};
		if (includeContent && typeof raw.raw_content === "string" && raw.raw_content.trim()) {
			result.content = raw.raw_content.trim();
		}
		results.push(result);
	}
	return results;
}

export function createBraveProvider(apiKey: string): SearchProvider {
	const trimmed = apiKey.trim();
	return {
		name: "brave",
		capabilities: new Set(["search", "freshness"]),
		async search(args) {
			const domains = normalizeDomains(args.domains);
			if (domains?.length === 1) {
				return searchBraveOnce({
					query: addSiteConstraint(args.query, domains[0]),
					maxResults: args.maxResults,
					freshness: args.freshness,
					signal: args.signal,
					apiKey: trimmed,
				});
			}
			return searchBraveOnce({
				query: args.query,
				maxResults: args.maxResults,
				freshness: args.freshness,
				signal: args.signal,
				apiKey: trimmed,
			});
		},
	};
}

export async function searchBraveOnce(args: {
	query: string;
	maxResults: number;
	freshness?: SearchFreshness;
	signal: AbortSignal;
	apiKey: string;
}): Promise<SearchResponse> {
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", args.query);
	url.searchParams.set("count", String(Math.min(Math.max(args.maxResults, 1), 20)));
	url.searchParams.set("result_filter", "web");
	const freshness = freshnessToBrave(args.freshness);
	if (freshness) url.searchParams.set("freshness", freshness);
	const results = await fetchJson<SearchResult[]>("brave", url.toString(), {
		headers: { Accept: "application/json", "X-Subscription-Token": args.apiKey },
		signal: args.signal,
		timeoutMs: SEARCH_TIMEOUT_BASIC_MS,
		maxBytes: MAX_RESPONSE_BYTES.search,
		validate: parseBraveResults,
	});
	return { results };
}

export function createExaProvider(apiKey: string): SearchProvider {
	const trimmed = apiKey.trim();
	const capabilities = new Set<SearchCapability>(["search", "content", "freshness", "domainFilter", "resultDates"]);
	return {
		name: "exa",
		capabilities,
		async search(args) {
			const body: Record<string, unknown> = {
				query: args.query,
				numResults: args.maxResults,
				type: "auto",
			};
			if (args.domains?.length) body.includeDomains = args.domains;
			const startPublishedDate = freshnessToPublishedDate(args.freshness);
			if (startPublishedDate) body.startPublishedDate = startPublishedDate;
			if (args.includeContent) body.contents = { text: { maxCharacters: 3000 } };
			const response = await fetchJson<{ results: unknown[] }>("exa", "https://api.exa.ai/search", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": trimmed,
				},
				body: JSON.stringify(body),
				signal: args.signal,
				timeoutMs: args.includeContent ? SEARCH_TIMEOUT_THOROUGH_MS : SEARCH_TIMEOUT_BASIC_MS,
				maxBytes: MAX_RESPONSE_BYTES.search,
				validate(value) {
					if (!isPlainObject(value) || !Array.isArray(value.results)) {
						throw new Error("Exa returned unexpected response shape.");
					}
					return { results: value.results };
				},
			});
			return { results: parseExaResults(response, args.includeContent) };
		},
	};
}

export function createTavilyProvider(apiKey: string): SearchProvider {
	const trimmed = apiKey.trim();
	const capabilities = new Set<SearchCapability>(["search", "content", "freshness", "domainFilter", "resultDates"]);
	return {
		name: "tavily",
		capabilities,
		async search(args) {
			const body: Record<string, unknown> = {
				query: args.query,
				topic:
					args.freshness &&
					/\b(latest|news|breaking|release|released|update|updated|today|yesterday|cve|vulnerability)\b/i.test(
						args.query,
					)
						? "news"
						: "general",
				search_depth: args.includeContent ? "advanced" : "basic",
				max_results: Math.max(1, Math.min(20, Math.trunc(args.maxResults))),
				include_answer: false,
				include_raw_content: args.includeContent ? "markdown" : false,
			};
			if (args.freshness) body.time_range = args.freshness;
			if (args.domains?.length) body.include_domains = args.domains;
			const response = await fetchJson<{ results?: unknown[] }>("tavily", "https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${trimmed}`,
				},
				body: JSON.stringify(body),
				signal: args.signal,
				timeoutMs: args.includeContent ? SEARCH_TIMEOUT_THOROUGH_MS : SEARCH_TIMEOUT_BASIC_MS,
				maxBytes: MAX_RESPONSE_BYTES.search,
				validate(value) {
					if (!isPlainObject(value) || (value.results !== undefined && !Array.isArray(value.results))) {
						throw new Error("Tavily returned unexpected response shape.");
					}
					return { results: value.results };
				},
			});
			const results = parseTavilyResults({ results: response.results ?? [] }, args.includeContent);
			return { results };
		},
	};
}
