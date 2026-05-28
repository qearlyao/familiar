import {
	FETCH_DEFAULT_MAX_CHARS,
	type FetchProviderName,
	SEARCH_OUTPUT_BUDGET,
	type SearchDepth,
	type SearchFreshness,
	type SearchProviderName,
	type SearchResponse,
	type SearchResult,
	WEB_UNTRUSTED_PREFIX,
} from "./types.js";
import { normalizeIsoDate } from "./util.js";

export function collectSearchNotes(requested: SearchDepth, served: SearchDepth, notes: string[] = []): string[] {
	if (requested !== served) {
		notes.push(`Depth: requested ${requested}, served ${served}`);
	}
	return [...new Set(notes)];
}

export function buildSearchDocument(args: {
	provider: SearchProviderName;
	depth: SearchDepth;
	freshness?: SearchFreshness;
	domains?: string[];
	results: SearchResult[];
	appliedFilters?: SearchResponse["appliedFilters"];
	notes?: string[];
}): string {
	const lines = [`## Search Results (via ${args.provider}, ${args.depth})`];
	if (args.notes?.length) {
		lines.push("", ...args.notes);
	}
	if (args.freshness || args.domains?.length || args.appliedFilters) {
		const notes = [];
		if (args.freshness) notes.push(`Freshness: ${args.freshness}`);
		if (args.domains?.length) notes.push(`Domains: ${args.domains.join(", ")}`);
		lines.push("", ...notes);
	}
	for (const [index, result] of args.results.entries()) {
		lines.push("", `### ${index + 1}. ${result.title}`, `URL: ${result.url}`);
		const published = normalizeIsoDate(result.publishedAt);
		if (published) lines.push(`Published: ${published.slice(0, 10)}`);
		lines.push(`Snippet: ${result.snippet || "[No snippet available]"}`);
		if (result.content) {
			lines.push("", "Content:", result.content);
		}
	}
	return lines.join("\n");
}

export function formatFetchContent(
	url: string,
	provider: FetchProviderName,
	chunk: {
		text: string;
		offset: number;
		totalChars: number;
		nextOffset?: number;
		hasMore: boolean;
		returnedChars: number;
	},
): string {
	const header = `## Content from ${url} (via ${provider})`;
	if (chunk.offset >= chunk.totalChars) {
		return prefixUntrustedWebContent(
			[
				header,
				"",
				`[Offset ${chunk.offset} is beyond the end of the document. Total content length: ${chunk.totalChars} characters.]`,
			].join("\n"),
		);
	}
	const lines = [
		header,
		"",
		`[Showing chars ${chunk.offset}-${chunk.offset + chunk.returnedChars - 1} of ${chunk.totalChars}]`,
		"",
		chunk.text,
	];
	if (chunk.hasMore && chunk.nextOffset !== undefined) {
		lines.push("", `[More content available. Next chunk: fetch_web(url="${url}", offset=${chunk.nextOffset})]`);
	}
	return prefixUntrustedWebContent(lines.join("\n"));
}

export function prefixUntrustedWebContent(text: string): string {
	return `${WEB_UNTRUSTED_PREFIX}\n\n${text}`;
}

export function paginateContent(
	content: string,
	offset: number,
	maxChars = FETCH_DEFAULT_MAX_CHARS,
): {
	text: string;
	offset: number;
	returnedChars: number;
	totalChars: number;
	nextOffset?: number;
	hasMore: boolean;
} {
	const totalChars = content.length;
	if (offset >= totalChars) {
		return { text: "", offset, returnedChars: 0, totalChars, hasMore: false };
	}
	const safeMaxChars = Math.max(1, Math.min(maxChars, 20_000));
	const end = Math.min(offset + safeMaxChars, totalChars);
	const text = content.slice(offset, end).trim();
	return {
		text,
		offset,
		returnedChars: text.length,
		totalChars,
		nextOffset: end < totalChars ? end : undefined,
		hasMore: end < totalChars,
	};
}

export function formatSearchResults(args: {
	results: SearchResult[];
	provider: SearchProviderName;
	requestedDepth: SearchDepth;
	servedDepth: SearchDepth;
	freshness?: SearchFreshness;
	domains?: string[];
	appliedFilters?: SearchResponse["appliedFilters"];
	notes?: string[];
}): string {
	const notes = collectSearchNotes(args.requestedDepth, args.servedDepth, [...(args.notes ?? [])]);
	const document = buildSearchDocument({
		provider: args.provider,
		depth: args.servedDepth,
		freshness: args.freshness,
		domains: args.domains,
		results: args.results,
		appliedFilters: args.appliedFilters,
		notes,
	});
	const output = prefixUntrustedWebContent(document);
	return output.length > SEARCH_OUTPUT_BUDGET ? `${output.slice(0, SEARCH_OUTPUT_BUDGET - 3).trimEnd()}...` : output;
}
